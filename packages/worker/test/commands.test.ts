import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { okReading, type Provider } from 'core'
import { Repo } from '../src/db.js'
import { createWorker } from '../src/index.js'
import { resetDb, telegramMock, testEnv, type TelegramMock } from './helpers.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

let tg: TelegramMock
let repo: Repo
let pending: Promise<unknown>[]

beforeEach(async () => {
  await resetDb()
  tg = telegramMock()
  pending = []
  repo = new Repo(env.DB, testEnv.CREDENTIALS_KEY)
})

const ctx = () => ({ waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} }) as unknown as ExecutionContext

async function send(
  text: string,
  opts: { chat?: number; secret?: string | null; body?: unknown; providers?: Provider<any>[] } = {},
): Promise<Response> {
  const worker = createWorker({ fetch: tg.fetch, sleep: async () => {}, providers: opts.providers ?? [] })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.secret !== null) headers['x-telegram-bot-api-secret-token'] = opts.secret ?? 'hook-secret'
  const body = opts.body ?? { update_id: 1, message: { chat: { id: opts.chat ?? 42 }, text } }
  const res = await worker.fetch(
    new Request('https://vigia.test/telegram', { method: 'POST', headers, body: JSON.stringify(body) }),
    testEnv,
    ctx(),
  )
  for (let done = 0; done < pending.length; ) {
    const batch = pending.slice(done)
    done += batch.length
    await Promise.all(batch)
  }
  return res
}

const seedQuota = (over: Record<string, unknown> = {}) =>
  repo.upsertCurrentQuota({
    provider: 'cursor',
    quotaId: 'monthly',
    name: 'Mensual',
    window: 'monthly',
    remainingFraction: 0.4,
    resetsAt: new Date(Date.now() + 3 * DAY).toISOString(),
    periodResetAt: new Date(Date.now() + 3 * DAY).toISOString(),
    readAt: new Date().toISOString(),
    source: 'cloud',
    ...over,
  })

describe('POST /telegram', () => {
  it('rejects a wrong or missing secret with 401', async () => {
    expect((await send('/ayuda', { secret: 'nope' })).status).toBe(401)
    expect((await send('/ayuda', { secret: null })).status).toBe(401)
    expect(tg.texts).toEqual([])
  })

  it('ignores other chats without replying', async () => {
    expect((await send('/ayuda', { chat: 99 })).status).toBe(200)
    expect(tg.requests).toEqual([])
  })

  it('ignores non-message updates and malformed bodies', async () => {
    expect((await send('', { body: { update_id: 2, edited_message: { chat: { id: 42 }, text: '/ayuda' } } })).status).toBe(200)
    expect((await send('', { body: 'garbage' })).status).toBe(200)
    expect(tg.requests).toEqual([])
  })

  it('/ayuda and /start list commands', async () => {
    await send('/ayuda')
    await send('/start')
    expect(tg.texts).toHaveLength(2)
    expect(tg.texts[0]).toContain('/estado')
    expect(tg.texts[0]).toContain('/silenciar')
  })

  it('answers unknown commands', async () => {
    await send('/foo')
    expect(tg.texts).toEqual(['No conozco ese comando, prueba /ayuda'])
  })

  it('/estado shows all quotas and /estado@Bot works', async () => {
    await seedQuota()
    await send('/estado@VigIABot')
    expect(tg.texts[0]).toContain('Estado de tus cuotas')
    expect(tg.texts[0]).toContain('Cursor')
  })

  it('hides Freebuff quotas from Telegram status and priority', async () => {
    await seedQuota({ provider: 'freebuff', quotaId: 'freebucks-daily', name: 'Freebuff (gratis, diario)', window: 'daily' })
    await send('/estado')
    await send('/prioridad')
    expect(tg.texts[0]).not.toContain('Freebuff')
    expect(tg.texts[1]).not.toContain('Freebuff')
  })

  it('/estado Cursor shows only that tool, case and accent insensitive', async () => {
    await seedQuota()
    await seedQuota({ provider: 'codex', quotaId: 'weekly' })
    await send('/estado CURSOR')
    expect(tg.texts[0]).toContain('Cursor')
    expect(tg.texts[0]).not.toContain('Codex')
  })

  it('resolves tools by label with spaces', async () => {
    await seedQuota({ provider: 'copilot' })
    await send('/estado github copilot')
    await send('/estado Mimo Code')
    expect(tg.texts[0]).toContain('GitHub Copilot')
    expect(tg.texts[1]).toContain('<b>MiMo Code</b> — sin datos del portátil')
    expect(tg.texts[1]).not.toContain('Copilot')
  })

  it('/estado lists enabled providers without data and hides disabled ones', async () => {
    await seedQuota({ provider: 'copilot' })
    const cfg = { ...testEnv, CONFIG_JSON: JSON.stringify({ disabled: ['kilo'] }) }
    const worker = createWorker({ fetch: tg.fetch, sleep: async () => {}, providers: [] })
    const body = { update_id: 1, message: { chat: { id: 42 }, text: '/estado' } }
    await worker.fetch(
      new Request('https://vigia.test/telegram', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'hook-secret' },
        body: JSON.stringify(body),
      }),
      cfg,
      ctx(),
    )
    await Promise.all(pending)
    expect(tg.texts[0]).toContain('GitHub Copilot')
    expect(tg.texts[0]).toContain('<b>Codex</b> — sin datos')
    expect(tg.texts[0]).toContain('<b>opencode</b> — sin datos del portátil')
    expect(tg.texts[0]).not.toContain('Kilo')
  })

  it('reports unknown tools with options', async () => {
    await send('/estado <b>x')
    expect(tg.texts[0]).toContain('No conozco «&lt;b&gt;x»')
    expect(tg.texts[0]).toContain('Opciones:')
    expect(tg.texts[0]).toContain('Cursor')
  })

  it('/prioridad lists future quotas with remaining balance by priority', async () => {
    const soon = new Date(Date.now() + 1 * DAY).toISOString()
    const later = new Date(Date.now() + 5 * DAY).toISOString()
    await seedQuota({ provider: 'codex', quotaId: 'a', resetsAt: later })
    await seedQuota({ provider: 'grok', quotaId: 'b', resetsAt: soon })
    await seedQuota({ provider: 'kilo', quotaId: 'c', remainingFraction: 0 })
    await seedQuota({ provider: 'qoder', quotaId: 'd', resetsAt: new Date(Date.now() - HOUR).toISOString() })
    await send('/prioridad')
    const text = tg.texts[0]!
    expect(text.indexOf('Grok')).toBeGreaterThan(-1)
    expect(text.indexOf('Grok')).toBeLessThan(text.indexOf('Codex'))
    expect(text).not.toContain('Kilo')
    expect(text).not.toContain('Qoder')
  })

  it('/prioridad shows <1 % for an almost empty quota', async () => {
    await seedQuota({ provider: 'codex', quotaId: 'a', remainingFraction: 0.004 })
    await send('/prioridad')
    expect(tg.texts[0]).toContain('— te queda &lt;1 % ·')
  })

  it('/historial without data', async () => {
    await send('/historial Cursor')
    expect(tg.texts).toEqual(['Aún no hay historial de Cursor'])
  })

  it('/historial lists the last 6 closes newest first', async () => {
    for (let i = 1; i <= 8; i++) {
      await repo.insertPeriodClose({
        provider: 'cursor',
        quotaId: 'monthly',
        window: 'monthly',
        periodResetAt: new Date(Date.UTC(2026, 0, i * 3, 12)).toISOString(),
        usedFraction: i / 10,
      })
    }
    await send('/historial cursor')
    const lines = tg.texts[0]!.split('\n').filter((l) => l.includes('→'))
    expect(lines).toHaveLength(6)
    expect(lines[0]).toContain('usado 80 %')
    expect(lines[5]).toContain('usado 30 %')
  })

  it('/historial without tool shows usage', async () => {
    await send('/historial')
    expect(tg.texts[0]).toContain('Uso: /historial')
  })

  it('/silenciar sets mutedUntil to now + days and /activar clears it', async () => {
    const before = Date.now()
    await send('/silenciar cursor 3')
    const after = Date.now()
    const muted = (await repo.getHealth()).find((h) => h.provider === 'cursor')!
    const until = Date.parse(muted.mutedUntil!)
    expect(until).toBeGreaterThanOrEqual(before + 3 * DAY)
    expect(until).toBeLessThanOrEqual(after + 3 * DAY)
    expect(tg.texts[0]).toMatch(/^🔕 Cursor silenciado hasta /)

    await send('/activar cursor')
    expect((await repo.getHealth()).find((h) => h.provider === 'cursor')!.mutedUntil).toBeUndefined()
    expect(tg.texts[1]).toBe('🔔 Cursor activado')
  })

  it('/silenciar preserves existing health', async () => {
    await repo.putHealth({ provider: 'cursor', consecutiveFailures: 2, brokenNotified: true, lastOkAt: '2026-10-01T00:00:00.000Z' })
    await send('/silenciar cursor 1')
    const h = (await repo.getHealth())[0]!
    expect(h.consecutiveFailures).toBe(2)
    expect(h.brokenNotified).toBe(true)
    expect(h.mutedUntil).toBeDefined()
  })

  it('/silenciar validates days and tool', async () => {
    for (const bad of ['/silenciar cursor 0', '/silenciar cursor -1', '/silenciar cursor 366', '/silenciar cursor 1.5', '/silenciar cursor x', '/silenciar cursor', '/silenciar']) {
      await send(bad)
    }
    expect(tg.texts).toHaveLength(7)
    for (const t of tg.texts) expect(t).toContain('Uso: /silenciar')
    expect(await repo.getHealth()).toEqual([])
    await send('/silenciar nada 3')
    expect(tg.texts[7]).toContain('No conozco «nada»')
  })

  it('/silenciar accepts multi-word tool names', async () => {
    await send('/silenciar github copilot 2')
    expect((await repo.getHealth())[0]!.provider).toBe('copilot')
  })

  it('/actualizar replies immediately, then sends the status with local data age', async () => {
    await seedQuota({ provider: 'antigravity', resetsAt: new Date(Date.now() + 20 * DAY).toISOString(), readAt: new Date(Date.now() - 3 * DAY).toISOString(), source: 'local' })
    await send('/actualizar')
    expect(tg.texts[0]).toBe('Actualizando…')
    expect(tg.texts[1]).toContain('Estado de tus cuotas')
    expect(tg.texts[1]).toContain('portátil')
    expect(tg.texts[1]).toContain('Antigravity')
  })

  it('/actualizar reports a failed refresh instead of staying silent', async () => {
    await repo.putCredential('codex', '{}')
    const broken: Provider<unknown> = {
      id: 'codex',
      source: 'cloud',
      parseCredential: (raw) => JSON.parse(raw),
      serializeCredential: (c) => JSON.stringify(c),
      read: async (ctx) => ({
        reading: okReading('codex', 'cloud', [{ provider: 'codex', quotaId: 'w', name: '<w>', window: 'weekly', remainingFraction: 0.5, resetsAt: 'nope' }], ctx.now()),
      }),
    }
    await send('/actualizar', { providers: [broken] })
    expect(tg.texts).toHaveLength(2)
    expect(tg.texts[1]).toMatch(/^No he podido actualizar: \S/)
    expect(tg.texts[1]!.length).toBeLessThanOrEqual(230)
  })

  it('/actualizar reports a busy evaluation', async () => {
    await repo.acquireLease('evaluate', 10 * 60_000, new Date())
    await send('/actualizar')
    expect(tg.texts).toEqual(['Actualizando…', 'Ya hay una actualización en curso, prueba en un minuto'])
  })
})
