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
    ['unknown provider', { readings: [{ ...reading(), provider: 'chatgpt' }] }],
    ['bad window', { readings: [{ ...reading(), quotas: [{ ...reading().quotas[0], window: 'yearly' }] }] }],
    ['readAt in the future', { readings: [{ ...reading(), readAt: iso(6 * 60_000) }] }],
    ['non-ISO readAt', { readings: [{ ...reading(), readAt: 'yesterday' }] }],
    ['non-ISO resetsAt', { readings: [{ ...reading(), quotas: [{ ...reading().quotas[0], resetsAt: '23/10/2026' }] }] }],
    ['fraction above 1', { readings: [{ ...reading(), quotas: [{ ...reading().quotas[0], remainingFraction: 1.2 }] }] }],
    ['negative fraction', { readings: [{ ...reading(), quotas: [{ ...reading().quotas[0], remainingFraction: -0.1 }] }] }],
    ['quota of another provider', { readings: [{ ...reading(), quotas: [{ ...reading().quotas[0], provider: 'codex' }] }] }],
    ['bad source', { readings: [{ ...reading(), source: 'laptop' }] }],
    ['bad error kind', { readings: [{ provider: 'mimo', ok: false, source: 'local', readAt: iso(0), error: { kind: 'boom', message: '' } }] }],
    ['credential for unknown provider', { readings: [], credentials: [{ provider: 'chatgpt', value: 'x' }] }],
    ['empty credential', { readings: [], credentials: [{ provider: 'cursor', value: '' }] }],
  ])('returns 400 for %s', async (_name, body) => {
    expect((await post(body)).status).toBe(400)
    const rows = await env.DB.prepare('SELECT * FROM snapshots').all()
    expect(rows.results).toEqual([])
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
