import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ProviderHealth, ProviderReading } from 'core'
import { Repo, type StoredQuota } from '../src/db.js'

const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))

const quota: StoredQuota = {
  provider: 'codex',
  quotaId: 'weekly',
  name: 'Weekly',
  window: 'weekly',
  remainingFraction: 0.4,
  remaining: 40,
  total: 100,
  unit: 'msgs',
  resetsAt: '2026-10-30T00:00:00.000Z',
  periodResetAt: '2026-10-30T00:00:00.000Z',
  readAt: '2026-10-23T10:00:00.000Z',
  source: 'cloud',
}

let repo: Repo

beforeEach(async () => {
  for (const t of ['snapshots', 'current_quotas', 'period_closes', 'sent_alerts', 'credentials', 'provider_health', 'leases'])
    await env.DB.exec(`DELETE FROM ${t}`)
  repo = new Repo(env.DB)
})

describe('Repo', () => {
  it('upserts and reads current quotas', async () => {
    await repo.upsertCurrentQuota(quota)
    expect(await repo.getCurrentQuotas()).toEqual([quota])
    await repo.upsertCurrentQuota({ ...quota, remainingFraction: 0.1, source: 'local' })
    const all = await repo.getCurrentQuotas()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ remainingFraction: 0.1, source: 'local' })
  })

  it('omits optional quota fields when absent', async () => {
    const { remaining, total, unit, ...bare } = quota
    await repo.upsertCurrentQuota(bare)
    expect(await repo.getCurrentQuotas()).toEqual([bare])
  })

  it('markSent is idempotent', async () => {
    expect(await repo.markSent('a:1')).toBe(true)
    expect(await repo.markSent('a:1')).toBe(false)
    await repo.markSent('b:1')
    expect(await repo.getSentKeys()).toEqual(new Set(['a:1', 'b:1']))
    expect(await repo.getSentKeys('a:')).toEqual(new Set(['a:1']))
  })

  it('acquireLease is exclusive until expiry', async () => {
    const t0 = new Date('2026-10-23T10:00:00Z')
    expect(await repo.acquireLease('eval', 60_000, t0)).toBe(true)
    expect(await repo.acquireLease('eval', 60_000, new Date(t0.getTime() + 1000))).toBe(false)
    expect(await repo.acquireLease('eval', 60_000, new Date(t0.getTime() + 61_000))).toBe(true)
  })

  it('releaseLease frees the lease', async () => {
    const t0 = new Date('2026-10-23T10:00:00Z')
    await repo.acquireLease('eval', 60_000, t0)
    await repo.releaseLease('eval')
    expect(await repo.acquireLease('eval', 60_000, t0)).toBe(true)
  })

  it('insertPeriodClose is idempotent and filterable', async () => {
    const c = { provider: 'codex' as const, quotaId: 'weekly', window: 'weekly' as const, periodResetAt: '2026-10-23T00:00:00.000Z', usedFraction: 0.3 }
    await repo.insertPeriodClose(c)
    await repo.insertPeriodClose({ ...c, usedFraction: 0.9 })
    await repo.insertPeriodClose({ ...c, provider: 'grok' })
    expect(await repo.getPeriodCloses('codex')).toEqual([c])
    expect(await repo.getPeriodCloses()).toHaveLength(2)
  })

  it('roundtrips provider health', async () => {
    const full: ProviderHealth = {
      provider: 'grok',
      consecutiveFailures: 2,
      lastError: { kind: 'network', message: 'boom' },
      brokenNotified: true,
      lastOkAt: '2026-10-22T00:00:00.000Z',
      mutedUntil: '2026-10-25T00:00:00.000Z',
    }
    const bare: ProviderHealth = { provider: 'kilo', consecutiveFailures: 0, brokenNotified: false }
    await repo.putHealth(full)
    await repo.putHealth(bare)
    await repo.putHealth({ ...full, consecutiveFailures: 3 })
    const all = await repo.getHealth()
    expect(all).toHaveLength(2)
    expect(all).toContainEqual({ ...full, consecutiveFailures: 3 })
    expect(all).toContainEqual(bare)
  })

  it('stores credentials encrypted at rest', async () => {
    const encRepo = new Repo(env.DB, key)
    expect(await encRepo.getCredential('cursor')).toBeNull()
    await encRepo.putCredential('cursor', 'tok-123')
    await encRepo.putCredential('cursor', 'tok-456')
    expect(await encRepo.getCredential('cursor')).toBe('tok-456')
    const raw = await env.DB.prepare('SELECT value FROM credentials WHERE provider = ?').bind('cursor').first<{ value: string }>()
    expect(raw?.value).not.toContain('tok-456')
  })

  it('purges old snapshots', async () => {
    const reading = (readAt: string): ProviderReading => ({ provider: 'codex', ok: true, quotas: [quota], readAt, source: 'cloud' })
    await repo.insertSnapshot(reading('2026-07-01T00:00:00.000Z'))
    await repo.insertSnapshot(reading('2026-10-01T00:00:00.000Z'))
    await repo.insertSnapshot({ provider: 'codex', ok: false, error: { kind: 'auth', message: 'x' }, readAt: '2026-07-02T00:00:00.000Z', source: 'cloud' })
    await repo.purgeSnapshotsBefore('2026-09-01T00:00:00.000Z')
    const rows = await env.DB.prepare('SELECT read_at FROM snapshots').all<{ read_at: string }>()
    expect(rows.results.map((r) => r.read_at)).toEqual(['2026-10-01T00:00:00.000Z'])
  })
})
