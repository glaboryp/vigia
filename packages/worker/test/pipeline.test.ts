import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ProviderId, ProviderReading, Quota } from 'core'
import { Repo } from '../src/db.js'
import { processReadings } from '../src/pipeline.js'
import { sendMessage } from '../src/telegram.js'
import { resetDb, telegramMock, testEnv, type TelegramMock } from './helpers.js'

const HOUR = 3_600_000
const NOW = new Date('2026-10-23T10:00:00.000Z')
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString()

const quota = (over: Partial<Quota> = {}): Quota => ({
  provider: 'codex',
  quotaId: 'weekly',
  name: 'Semanal',
  window: 'weekly',
  remainingFraction: 0.5,
  resetsAt: at(12 * HOUR),
  ...over,
})

const ok = (provider: ProviderId, quotas: Quota[], readAt = NOW.toISOString()): ProviderReading => ({
  provider,
  ok: true,
  quotas: quotas.map((q) => ({ ...q, provider })),
  readAt,
  source: 'cloud',
})

const fail = (provider: ProviderId, readAt: string, kind: 'auth' | 'network' = 'auth'): ProviderReading => ({
  provider,
  ok: false,
  error: { kind, message: 'HTTP 401' },
  readAt,
  source: 'cloud',
})

let tg: TelegramMock
let repo: Repo

beforeEach(async () => {
  await resetDb()
  tg = telegramMock()
  repo = new Repo(env.DB, testEnv.CREDENTIALS_KEY)
})

const run = (readings: ProviderReading[], now = NOW) => processReadings(testEnv, readings, now, { fetch: tg.fetch })

describe('sendMessage', () => {
  it('posts HTML to the configured chat', async () => {
    expect(await sendMessage(testEnv, 'hola', tg.fetch)).toBe(true)
    expect(tg.requests).toEqual([
      {
        url: 'https://api.telegram.org/botbot-token/sendMessage',
        body: { chat_id: '42', text: 'hola', parse_mode: 'HTML', disable_web_page_preview: true },
      },
    ])
  })

  it('returns false on non-2xx', async () => {
    tg.status = 429
    expect(await sendMessage(testEnv, 'hola', tg.fetch)).toBe(false)
  })

  it('returns false on network error', async () => {
    tg.fail = true
    expect(await sendMessage(testEnv, 'hola', tg.fetch)).toBe(false)
  })
})

describe('processReadings', () => {
  it('stores a snapshot and the current quota', async () => {
    await run([ok('codex', [quota({ resetsAt: at(5 * 24 * HOUR) })])])
    const rows = await env.DB.prepare('SELECT provider FROM snapshots').all()
    expect(rows.results).toHaveLength(1)
    expect(await repo.getCurrentQuotas()).toEqual([
      expect.objectContaining({ provider: 'codex', periodResetAt: at(5 * 24 * HOUR), readAt: NOW.toISOString() }),
    ])
    expect(tg.texts).toEqual([])
  })

  it('sends one renewal when an exhausted quota starts a new period', async () => {
    const first = quota({ provider: 'antigravity', quotaId: 'gemini', name: 'Gemini', remainingFraction: 0, resetsAt: at(2 * HOUR) })
    await run([ok('antigravity', [first])])
    const later = new Date(NOW.getTime() + 3 * HOUR)
    const renewed = { ...first, remainingFraction: 1, resetsAt: at(2 * HOUR + 7 * 24 * HOUR) }
    await run([ok('antigravity', [renewed], later.toISOString())], later)
    expect(tg.texts).toHaveLength(1)
    expect(tg.texts[0]).toContain('Cuota renovada')
    expect(tg.texts[0]).toContain('Antigravity')
    expect(await repo.getSentKeys('renewed:')).toEqual(
      new Set([`renewed:antigravity:gemini:${new Date(Date.parse(renewed.resetsAt)).toISOString()}`]),
    )
    expect(await repo.getPeriodCloses()).toEqual([
      { provider: 'antigravity', quotaId: 'gemini', window: 'weekly', periodResetAt: at(2 * HOUR), usedFraction: 1 },
    ])
    expect((await repo.getCurrentQuotas())[0]).toMatchObject({ periodResetAt: renewed.resetsAt, remainingFraction: 1 })

    await run([ok('antigravity', [renewed], later.toISOString())], later)
    expect(tg.texts).toHaveLength(1)
  })

  it('keeps periodResetAt within the same period despite resetsAt jitter', async () => {
    await run([ok('codex', [quota({ resetsAt: at(5 * 24 * HOUR) })])])
    await run([ok('codex', [quota({ resetsAt: at(5 * 24 * HOUR + 60_000) })], at(HOUR))], new Date(at(HOUR)))
    expect((await repo.getCurrentQuotas())[0]).toMatchObject({
      resetsAt: at(5 * 24 * HOUR + 60_000),
      periodResetAt: at(5 * 24 * HOUR),
    })
    expect(await repo.getPeriodCloses()).toEqual([])
  })

  it('does not record a period close when the previous reading is unreliable', async () => {
    await run([ok('codex', [quota({ remainingFraction: 0.3, resetsAt: at(5 * 24 * HOUR) })])])
    const later = new Date(NOW.getTime() + 6 * 24 * HOUR)
    await run([ok('codex', [quota({ remainingFraction: 1, resetsAt: at(12 * 24 * HOUR) })], later.toISOString())], later)
    expect(await repo.getPeriodCloses()).toEqual([])
    expect(tg.texts).toEqual([])
  })

  it('retries a renewal whose send failed on the next reading', async () => {
    const first = quota({ remainingFraction: 0, resetsAt: at(2 * HOUR) })
    await run([ok('codex', [first])])
    const later = new Date(NOW.getTime() + 3 * HOUR)
    const renewed = { ...first, remainingFraction: 1, resetsAt: at(2 * HOUR + 7 * 24 * HOUR) }
    tg.status = 500
    await run([ok('codex', [renewed], later.toISOString())], later)
    expect(await repo.getSentKeys('renewed:')).toEqual(new Set())
    tg.status = 200
    const again = new Date(later.getTime() + HOUR)
    await run([ok('codex', [renewed], again.toISOString())], again)
    expect(tg.texts).toHaveLength(1)
    expect(tg.texts[0]).toContain('Cuota renovada')
  })

  it('groups every due use-or-lose quota into one message', async () => {
    await run([
      ok('codex', [quota({ resetsAt: at(20 * HOUR), remainingFraction: 0.4 })]),
      ok('copilot', [quota({ quotaId: 'premium', name: 'Premium', window: 'monthly', resetsAt: at(3 * 24 * HOUR), remainingFraction: 0.7 })]),
    ])
    expect(tg.texts).toHaveLength(1)
    expect(tg.texts[0]).toContain('Úsalo o piérdelo')
    expect(tg.texts[0]).toContain('Codex')
    expect(tg.texts[0]).toContain('GitHub Copilot')
    expect(tg.texts[0]!.indexOf('Codex')).toBeLessThan(tg.texts[0]!.indexOf('GitHub Copilot'))
    expect((await repo.getSentKeys('useorlose:')).size).toBe(2)
  })

  it('evaluates use-or-lose over stored quotas, not only the new readings', async () => {
    await run([ok('codex', [quota({ resetsAt: at(30 * HOUR) })])])
    expect(tg.texts).toEqual([])
    const later = new Date(NOW.getTime() + 8 * HOUR)
    await run([ok('kilo', [quota({ quotaId: 'credits', window: 'daily', resetsAt: at(20 * HOUR) })], later.toISOString())], later)
    expect(tg.texts).toHaveLength(1)
    expect(tg.texts[0]).toContain('Codex')
    expect(tg.texts[0]).not.toContain('Kilo')
  })

  it('does not resend when the same evaluation repeats', async () => {
    const readings = [ok('codex', [quota()]), fail('cursor', NOW.toISOString())]
    await run(readings)
    await run(readings)
    await run([])
    expect(tg.texts).toHaveLength(2)
    expect((await repo.getHealth()).find((h) => h.provider === 'cursor')?.consecutiveFailures).toBe(1)
  })

  it('marks nothing when Telegram fails and sends on the next evaluation', async () => {
    tg.status = 500
    await run([ok('codex', [quota()])])
    expect(tg.requests).toHaveLength(1)
    expect(await repo.getSentKeys()).toEqual(new Set())
    tg.status = 200
    await run([])
    expect(tg.texts).toHaveLength(1)
    expect(tg.texts[0]).toContain('Úsalo o piérdelo')
    expect((await repo.getSentKeys('useorlose:')).size).toBe(1)
  })

  it('marks nothing when Telegram is unreachable', async () => {
    tg.fail = true
    await run([ok('codex', [quota()])])
    expect(await repo.getSentKeys()).toEqual(new Set())
  })

  it('skips use-or-lose, renewal and health messages for muted providers', async () => {
    await repo.putHealth({ provider: 'codex', consecutiveFailures: 0, brokenNotified: false, mutedUntil: at(24 * HOUR) })
    await repo.putHealth({ provider: 'cursor', consecutiveFailures: 0, brokenNotified: false, mutedUntil: at(24 * HOUR) })
    await run([
      ok('codex', [quota()]),
      ok('grok', [quota({ quotaId: 'grok-weekly', resetsAt: at(10 * HOUR) })]),
      fail('cursor', NOW.toISOString()),
    ])
    expect(tg.texts).toHaveLength(1)
    expect(tg.texts[0]).toContain('Grok')
    expect(tg.texts[0]).not.toContain('Codex')
    expect((await repo.getHealth()).find((h) => h.provider === 'cursor')).toMatchObject({
      consecutiveFailures: 1,
      brokenNotified: false,
    })
  })

  it('stops muting once mutedUntil has passed', async () => {
    await repo.putHealth({ provider: 'codex', consecutiveFailures: 0, brokenNotified: false, mutedUntil: at(-HOUR) })
    await run([ok('codex', [quota()])])
    expect(tg.texts).toHaveLength(1)
  })

  it('sends broken once and recovered when the provider works again', async () => {
    await run([fail('cursor', at(0))])
    await run([fail('cursor', at(HOUR))], new Date(at(HOUR)))
    expect(tg.texts).toHaveLength(1)
    expect(tg.texts[0]).toContain('No puedo leer Cursor')
    expect(await repo.getSentKeys('health:')).toEqual(new Set([`health:cursor:broken:${at(0)}`]))

    await run([ok('cursor', [], at(2 * HOUR))], new Date(at(2 * HOUR)))
    expect(tg.texts).toHaveLength(2)
    expect(tg.texts[1]).toContain('Cursor</b> vuelve a funcionar')
    expect(await repo.getSentKeys('health:')).toContain(`health:cursor:recovered:${at(2 * HOUR)}`)
  })

  it('alerts after three consecutive non-auth failures', async () => {
    for (let i = 0; i < 3; i++) await run([fail('grok', at(i * HOUR), 'network')], new Date(at(i * HOUR)))
    expect(tg.texts).toHaveLength(1)
    expect(await repo.getSentKeys('health:')).toEqual(new Set([`health:grok:broken:${at(2 * HOUR)}`]))
  })

  it('retries a broken alert whose send failed on the next failure', async () => {
    tg.status = 500
    await run([fail('cursor', at(0))])
    expect((await repo.getHealth())[0]).toMatchObject({ brokenNotified: false, consecutiveFailures: 1 })
    tg.status = 200
    await run([fail('cursor', at(HOUR))], new Date(at(HOUR)))
    expect(tg.texts).toHaveLength(1)
    expect((await repo.getHealth())[0]).toMatchObject({ brokenNotified: true, consecutiveFailures: 2 })
  })

  it('retries a recovered message whose send failed on the next ok reading', async () => {
    await run([fail('cursor', at(0))])
    tg.status = 500
    await run([ok('cursor', [], at(HOUR))], new Date(at(HOUR)))
    tg.status = 200
    await run([ok('cursor', [], at(2 * HOUR))], new Date(at(2 * HOUR)))
    expect(tg.texts).toHaveLength(2)
    expect(tg.texts[1]).toContain('vuelve a funcionar')
    await run([ok('cursor', [], at(3 * HOUR))], new Date(at(3 * HOUR)))
    expect(tg.texts).toHaveLength(2)
  })

  it('ignores a reading older than the stored quota', async () => {
    await run([ok('codex', [quota({ remainingFraction: 0.2, resetsAt: at(5 * 24 * HOUR) })], at(HOUR))], new Date(at(HOUR)))
    await run([ok('codex', [quota({ remainingFraction: 0.9, resetsAt: at(5 * 24 * HOUR) })], at(0))], new Date(at(HOUR)))
    expect((await repo.getCurrentQuotas())[0]).toMatchObject({ remainingFraction: 0.2, readAt: at(HOUR) })
  })

  it('gives up without evaluating when the lease stays taken', async () => {
    const holder = await repo.acquireLease('evaluate', 60_000, NOW)
    expect(holder).not.toBeNull()
    let sleeps = 0
    await processReadings(testEnv, [ok('codex', [quota()])], NOW, {
      fetch: tg.fetch,
      sleep: async () => {
        sleeps++
      },
    })
    expect(sleeps).toBe(3)
    expect(tg.requests).toEqual([])
    const rows = await env.DB.prepare('SELECT * FROM snapshots').all()
    expect(rows.results).toEqual([])
  })

  it('sends a single message when two evaluations overlap', async () => {
    const readings = [ok('codex', [quota()])]
    const first = run(readings)
    const second = processReadings(testEnv, readings, NOW, { fetch: tg.fetch, sleep: () => first })
    await Promise.all([first, second])
    expect(tg.texts).toHaveLength(1)
    expect(await repo.acquireLease('evaluate', 60_000, NOW)).not.toBeNull()
  })

  it('releases the lease even if evaluation throws', async () => {
    const bad: ProviderReading = { ...ok('codex', [quota()]), quotas: [quota({ resetsAt: 'nope' })] } as ProviderReading
    await expect(run([bad])).rejects.toThrow()
    expect(await repo.acquireLease('evaluate', 60_000, NOW)).not.toBeNull()
  })
})
