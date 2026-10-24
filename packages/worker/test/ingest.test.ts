import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Repo } from '../src/db.js'
import { createWorker } from '../src/index.js'
import { resetDb, telegramMock, testEnv, type TelegramMock } from './helpers.js'

const HOUR = 3_600_000
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

const reading = () => ({
  provider: 'antigravity',
  ok: true,
  source: 'local',
  readAt: iso(0),
  quotas: [
    {
      provider: 'antigravity',
      quotaId: 'gemini',
      name: 'Gemini',
      window: 'weekly',
      remainingFraction: 0.6,
      resetsAt: iso(10 * HOUR),
    },
  ],
})

const worker = createWorker({ sleep: async () => {} })

const post = (body: unknown, token: string | null = testEnv.INGEST_TOKEN) =>
  worker.fetch(
    new Request('https://vigia.test/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token !== null && { authorization: `Bearer ${token}` }),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    testEnv,
    {} as ExecutionContext,
  )

let tg: TelegramMock

beforeEach(async () => {
  await resetDb()
  tg = telegramMock()
  vi.stubGlobal('fetch', tg.fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /ingest', () => {
  it('rejects requests without the ingest token', async () => {
    expect((await post({ readings: [] }, null)).status).toBe(401)
    expect((await post({ readings: [] }, 'wrong')).status).toBe(401)
    const rows = await env.DB.prepare('SELECT * FROM snapshots').all()
    expect(rows.results).toEqual([])
  })

  it('accepts a valid payload and stores the reading', async () => {
    const res = await post({ readings: [reading()] })
    expect(res.status).toBe(204)
    const quotas = await new Repo(env.DB).getCurrentQuotas()
    expect(quotas).toEqual([expect.objectContaining({ provider: 'antigravity', quotaId: 'gemini', source: 'local' })])
  })

  it('accepts failed readings', async () => {
    const failed = { provider: 'mimo', ok: false, source: 'local', readAt: iso(0), error: { kind: 'auth', message: 'code 401' } }
    expect((await post({ readings: [failed] })).status).toBe(204)
    expect(tg.texts).toHaveLength(1)
    expect(tg.texts[0]).toContain('No puedo leer MiMo Code')
  })

  it.each([
    ['malformed JSON', '{'],
    ['missing readings', {}],
    ['readings not an array', { readings: {} }],
    ['credential for unknown provider', { readings: [], credentials: [{ provider: 'chatgpt', value: 'x' }] }],
    ['empty credential', { readings: [], credentials: [{ provider: 'cursor', value: '' }] }],
    ['credentials not an array', { readings: [], credentials: {} }],
  ])('returns 400 for %s', async (_name, body) => {
    expect((await post(body)).status).toBe(400)
    const rows = await env.DB.prepare('SELECT * FROM snapshots').all()
    expect(rows.results).toEqual([])
  })

  const q0 = () => reading().quotas[0]
  it.each([
    ['bad window', { ...reading(), quotas: [{ ...q0(), window: 'yearly' }] }, 'quota.window'],
    ['readAt in the future', { ...reading(), readAt: iso(6 * 60_000) }, 'reading.readAt'],
    ['non-ISO readAt', { ...reading(), readAt: 'yesterday' }, 'reading.readAt'],
    ['non-ISO resetsAt', { ...reading(), quotas: [{ ...q0(), resetsAt: '23/10/2026' }] }, 'quota.resetsAt'],
    ['fraction above 1', { ...reading(), quotas: [{ ...q0(), remainingFraction: 1.2 }] }, 'quota.remainingFraction'],
    ['negative fraction', { ...reading(), quotas: [{ ...q0(), remainingFraction: -0.1 }] }, 'quota.remainingFraction'],
    ['quota of another provider', { ...reading(), quotas: [{ ...q0(), provider: 'codex' }] }, 'quota.provider'],
    ['bad source', { ...reading(), source: 'laptop' }, 'reading.source'],
    ['bad error kind', { provider: 'antigravity', ok: false, source: 'local', readAt: iso(0), error: { kind: 'boom', message: '' } }, 'reading.error'],
  ])('turns a reading with %s into a parse error reading', async (_name, bad, reason) => {
    const good = { provider: 'mimo', ok: false, source: 'local', readAt: iso(0), error: { kind: 'network', message: 'down' } }
    expect((await post({ readings: [bad, good] })).status).toBe(204)
    const rows = await env.DB.prepare('SELECT provider, ok, error_kind, error_message, source FROM snapshots ORDER BY provider').all()
    expect(rows.results).toEqual([
      { provider: 'antigravity', ok: 0, error_kind: 'parse', error_message: `Lectura inválida del agente: ${reason}`, source: 'local' },
      { provider: 'mimo', ok: 0, error_kind: 'network', error_message: 'down', source: 'local' },
    ])
  })

  it('drops readings with an unknown or missing provider and keeps the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await post({ readings: [{ ...reading(), provider: 'chatgpt' }, { ok: true }, 'nope', reading()] })
    expect(res.status).toBe(204)
    const rows = await env.DB.prepare('SELECT provider, ok FROM snapshots').all()
    expect(rows.results).toEqual([{ provider: 'antigravity', ok: 1 }])
    expect(warn).toHaveBeenCalledWith('ingest: dropped 3 readings without a known provider')
    warn.mockRestore()
  })

  it('stores pushed credentials encrypted', async () => {
    const res = await post({ readings: [], credentials: [{ provider: 'cursor', value: 'cursor-token-123' }] })
    expect(res.status).toBe(204)
    const raw = await env.DB.prepare('SELECT value FROM credentials WHERE provider = ?').bind('cursor').first<{ value: string }>()
    expect(raw?.value).toBeTruthy()
    expect(raw?.value).not.toContain('cursor-token-123')
    expect(await new Repo(env.DB, testEnv.CREDENTIALS_KEY).getCredential('cursor')).toBe('cursor-token-123')
  })

  it('sends a single message when the same payload arrives twice', async () => {
    const body = { readings: [reading()] }
    expect((await post(body)).status).toBe(204)
    expect((await post(body)).status).toBe(204)
    expect(tg.texts).toHaveLength(1)
    expect(tg.texts[0]).toContain('Úsalo o piérdelo')
  })

  it('accepts a readAt slightly ahead of the server clock', async () => {
    expect((await post({ readings: [{ ...reading(), readAt: iso(60_000) }] })).status).toBe(204)
  })

  it('answers 503 while another evaluation holds the lease', async () => {
    const repo = new Repo(env.DB)
    const token = (await repo.acquireLease('evaluate', 60_000, new Date()))!
    const body = { readings: [reading()], credentials: [{ provider: 'cursor', value: 'tok' }] }
    const busy = await post(body)
    expect(busy.status).toBe(503)
    expect(busy.headers.get('retry-after')).toBe('30')
    expect((await env.DB.prepare('SELECT * FROM snapshots').all()).results).toEqual([])
    expect(tg.requests).toEqual([])
    expect((await env.DB.prepare('SELECT * FROM credentials').all()).results).toEqual([])
    await repo.releaseLease('evaluate', token)
    expect((await post(body)).status).toBe(204)
    expect((await env.DB.prepare('SELECT * FROM snapshots').all()).results).toHaveLength(1)
    expect(tg.texts).toHaveLength(1)
  })
})
