import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { errorReading, okReading, type Provider, type ProviderId, type Quota } from 'core'
import { Repo } from '../src/db.js'
import { runCloudProviders, runScheduled } from '../src/cron.js'
import { createWorker } from '../src/index.js'
import { resetDb, telegramMock, testEnv, type TelegramMock } from './helpers.js'

const DAY = 86_400_000
const MONDAY_0910 = new Date('2026-10-26T08:10:00.000Z')
const MONDAY_1000 = new Date('2026-10-26T09:00:00.000Z')
const FIRST_0910 = new Date('2026-11-01T08:10:00.000Z')
const TUESDAY = new Date('2026-10-27T08:10:00.000Z')

const quota = (provider: ProviderId, now: Date): Quota => ({
  provider,
  quotaId: 'weekly',
  name: 'Semanal',
  window: 'weekly',
  remainingFraction: 0.5,
  resetsAt: new Date(now.getTime() + 5 * DAY).toISOString(),
})

function fake(id: ProviderId, behavior: 'ok' | 'throw' = 'ok'): Provider<{ token: string }> & { reads: number } {
  const p = {
    id,
    source: 'cloud' as const,
    reads: 0,
    parseCredential: (raw: string) => JSON.parse(raw) as { token: string },
    serializeCredential: (c: { token: string }) => JSON.stringify(c),
    async read(ctx: { now: () => Date }) {
      p.reads++
      if (behavior === 'throw') throw new Error('boom')
      return { reading: okReading(id, 'cloud', [quota(id, ctx.now())], ctx.now()) }
    },
  }
  return p
}

let tg: TelegramMock
let repo: Repo

beforeEach(async () => {
  await resetDb()
  tg = telegramMock()
  repo = new Repo(env.DB, testEnv.CREDENTIALS_KEY)
})

const cred = (id: ProviderId) => repo.putCredential(id, JSON.stringify({ token: 't' }))
const sched = (now: Date, providers: Provider<any>[] = []) =>
  runScheduled(testEnv, now, { fetch: tg.fetch, providers, sleep: async () => {} })

describe('runCloudProviders', () => {
  it('returns a reading per provider and isolates exceptions', async () => {
    await cred('codex')
    await cred('copilot')
    const readings = await runCloudProviders(testEnv, MONDAY_0910, {
      fetch: tg.fetch,
      providers: [fake('codex', 'throw'), fake('copilot')],
    })
    expect(readings).toEqual([
      expect.objectContaining({ provider: 'codex', ok: false, error: expect.objectContaining({ kind: 'unavailable' }) }),
      expect.objectContaining({ provider: 'copilot', ok: true }),
    ])
  })

  it('reports auth when no credential is stored', async () => {
    const [r] = await runCloudProviders(testEnv, MONDAY_0910, { providers: [fake('codex')] })
    expect(r).toEqual(errorReading('codex', 'cloud', 'auth', 'No hay credencial configurada', MONDAY_0910))
  })

  it('reports auth when the stored credential is invalid', async () => {
    await repo.putCredential('codex', 'not json')
    const [r] = await runCloudProviders(testEnv, MONDAY_0910, { providers: [fake('codex')] })
    expect(r).toEqual(errorReading('codex', 'cloud', 'auth', 'Credencial inválida', MONDAY_0910))
  })

  it('persists a rotated credential', async () => {
    await cred('codex')
    const p = fake('codex')
    p.read = async (ctx) => ({
      reading: okReading('codex', 'cloud', [], ctx.now()),
      rotatedCredential: { token: 'new' },
    })
    await runCloudProviders(testEnv, MONDAY_0910, { providers: [p] })
    expect(await repo.getCredential('codex')).toBe(JSON.stringify({ token: 'new' }))
  })

  it('skips a provider whose lease is held', async () => {
    await cred('codex')
    await repo.acquireLease('provider:codex', 120_000, MONDAY_0910)
    const p = fake('codex')
    expect(await runCloudProviders(testEnv, MONDAY_0910, { providers: [p] })).toEqual([])
    expect(p.reads).toBe(0)
  })

  it('releases the lease afterwards', async () => {
    await cred('codex')
    await runCloudProviders(testEnv, MONDAY_0910, { providers: [fake('codex')] })
    expect(await repo.acquireLease('provider:codex', 120_000, MONDAY_0910)).not.toBeNull()
  })

  it('skips disabled providers and tolerates invalid config', async () => {
    await cred('codex')
    await cred('copilot')
    const disabled = { ...testEnv, CONFIG_JSON: JSON.stringify({ disabled: ['codex'] }) }
    const readings = await runCloudProviders(disabled, MONDAY_0910, { providers: [fake('codex'), fake('copilot')] })
    expect(readings.map((r) => r.provider)).toEqual(['copilot'])
    const broken = { ...testEnv, CONFIG_JSON: '{nope' }
    const all = await runCloudProviders(broken, MONDAY_0910, { providers: [fake('codex'), fake('copilot')] })
    expect(all).toHaveLength(2)
  })
})

describe('runScheduled', () => {
  it('sends the weekly digest once on Monday 09:10 Madrid', async () => {
    await sched(MONDAY_0910)
    await sched(new Date(MONDAY_0910.getTime() + 60_000))
    expect(tg.texts.filter((t) => t.includes('Estado de tus cuotas'))).toHaveLength(1)
    expect(await repo.getSentKeys('weekly:')).toEqual(new Set(['weekly:2026-W44']))
  })

  it('does not send the digest outside the window', async () => {
    await sched(MONDAY_1000)
    await sched(TUESDAY)
    expect(tg.texts).toEqual([])
  })

  it('retries the digest when sending fails', async () => {
    tg.status = 500
    await sched(MONDAY_0910)
    expect(await repo.getSentKeys('weekly:')).toEqual(new Set())
    tg.status = 200
    await sched(new Date(MONDAY_0910.getTime() + 60_000))
    expect(tg.texts).toHaveLength(1)
  })

  it('stays silent on day 1 without surplus but records the check', async () => {
    await sched(FIRST_0910)
    expect(tg.texts).toEqual([])
    expect(await repo.getSentKeys('surplus:')).toEqual(new Set(['surplus:2026-11']))
  })

  it('sends the surplus message on day 1 when under-used', async () => {
    for (const m of [7, 8, 9]) {
      await repo.insertPeriodClose({
        provider: 'codex',
        quotaId: 'monthly',
        window: 'monthly',
        periodResetAt: `2026-0${m}-01T00:00:00.000Z`,
        usedFraction: 0.1,
      })
    }
    await sched(FIRST_0910)
    await sched(new Date(FIRST_0910.getTime() + 60_000))
    expect(tg.texts.filter((t) => t.includes('Te sobra el plan'))).toHaveLength(1)
  })

  it('honours the surplus override in CONFIG_JSON', async () => {
    for (const m of [7, 8, 9]) {
      await repo.insertPeriodClose({
        provider: 'codex',
        quotaId: 'monthly',
        window: 'monthly',
        periodResetAt: `2026-0${m}-01T00:00:00.000Z`,
        usedFraction: 0.1,
      })
    }
    const cfg = { ...testEnv, CONFIG_JSON: JSON.stringify({ surplus: { threshold: 0.05 } }) }
    await runScheduled(cfg, FIRST_0910, { fetch: tg.fetch, providers: [] })
    expect(tg.texts).toEqual([])
  })

  it('purges snapshots older than 90 days', async () => {
    const old = new Date(MONDAY_0910.getTime() - 91 * DAY)
    const recent = new Date(MONDAY_0910.getTime() - 89 * DAY)
    await repo.insertSnapshot(okReading('codex', 'cloud', [], old))
    await repo.insertSnapshot(okReading('codex', 'cloud', [], recent))
    await sched(TUESDAY)
    const rows = await env.DB.prepare('SELECT read_at FROM snapshots').all<{ read_at: string }>()
    expect(rows.results.map((r) => r.read_at)).toEqual([recent.toISOString()])
  })

  it('skips digests when evaluation is busy', async () => {
    await repo.acquireLease('evaluate', 60_000, MONDAY_0910)
    await sched(MONDAY_0910)
    expect(tg.texts).toEqual([])
  })

  it('feeds provider readings into the pipeline', async () => {
    await cred('codex')
    await sched(TUESDAY, [fake('codex')])
    expect(await repo.getCurrentQuotas()).toHaveLength(1)
  })
})

describe('scheduled handler', () => {
  it('runs the cron through waitUntil', async () => {
    const worker = createWorker({ fetch: tg.fetch, providers: [] })
    const pending: Promise<unknown>[] = []
    await worker.scheduled(
      { scheduledTime: MONDAY_0910.getTime(), cron: '*/15 * * * *', noRetry() {} },
      testEnv,
      { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as ExecutionContext,
    )
    await Promise.all(pending)
    expect(tg.texts).toHaveLength(1)
  })
})
