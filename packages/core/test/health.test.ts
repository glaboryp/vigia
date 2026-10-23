import { describe, expect, it } from 'vitest'
import { FAILURES_BEFORE_ALERT, STALE_LOCAL_MS, isStale, nextHealth, type ProviderHealth } from '../src/alerts/health.js'
import type { ErrorKind, ProviderReading } from '../src/types.js'

const fail = (kind: ErrorKind, readAt = '2026-10-23T10:00:00.000Z'): ProviderReading => ({
  provider: 'cursor',
  ok: false,
  error: { kind, message: `${kind} error` },
  readAt,
  source: 'cloud',
})

const ok = (readAt = '2026-10-23T11:00:00.000Z'): ProviderReading => ({
  provider: 'cursor',
  ok: true,
  quotas: [],
  readAt,
  source: 'cloud',
})

describe('nextHealth', () => {
  it('constants', () => {
    expect(FAILURES_BEFORE_ALERT).toBe(3)
    expect(STALE_LOCAL_MS).toBe(48 * 3600_000)
  })
  it('flags an auth error as broken immediately', () => {
    const { health, event } = nextHealth(undefined, fail('auth'))
    expect(event).toBe('broken')
    expect(health).toMatchObject({ consecutiveFailures: 1, brokenNotified: true, lastError: { kind: 'auth', message: 'auth error' } })
  })
  it('flags other errors as broken on the third consecutive failure only once', () => {
    const r1 = nextHealth(undefined, fail('network'))
    const r2 = nextHealth(r1.health, fail('network'))
    const r3 = nextHealth(r2.health, fail('network'))
    const r4 = nextHealth(r3.health, fail('network'))
    expect([r1.event, r2.event, r3.event, r4.event]).toEqual([undefined, undefined, 'broken', undefined])
    expect(r4.health.consecutiveFailures).toBe(4)
    expect(r4.health.brokenNotified).toBe(true)
  })
  it('reports recovery after a notified break and resets the counter', () => {
    const broken = nextHealth(undefined, fail('auth')).health
    const { health, event } = nextHealth(broken, ok('2026-10-23T12:00:00.000Z'))
    expect(event).toBe('recovered')
    expect(health).toMatchObject({ consecutiveFailures: 0, brokenNotified: false, lastOkAt: '2026-10-23T12:00:00.000Z' })
    expect(health.lastError).toBeUndefined()
  })
  it('emits no event on ok when nothing was notified', () => {
    const prev = nextHealth(undefined, fail('network')).health
    const { health, event } = nextHealth(prev, ok())
    expect(event).toBeUndefined()
    expect(health.consecutiveFailures).toBe(0)
  })
  it('preserves mutedUntil across updates', () => {
    const prev: ProviderHealth = { provider: 'cursor', consecutiveFailures: 0, brokenNotified: false, mutedUntil: '2026-11-01T00:00:00.000Z' }
    expect(nextHealth(prev, fail('parse')).health.mutedUntil).toBe('2026-11-01T00:00:00.000Z')
    expect(nextHealth(prev, ok()).health.mutedUntil).toBe('2026-11-01T00:00:00.000Z')
  })
})

describe('isStale', () => {
  const now = new Date('2026-10-23T12:00:00.000Z')
  const health = (lastOkAt?: string): ProviderHealth => ({ provider: 'mimo', consecutiveFailures: 0, brokenNotified: false, lastOkAt })

  it('marks local sources stale after 48 h without data', () => {
    expect(isStale(health('2026-10-21T11:00:00.000Z'), 'local', now)).toBe(true)
    expect(isStale(health('2026-10-22T12:00:00.000Z'), 'local', now)).toBe(false)
  })
  it('never marks cloud sources stale', () => {
    expect(isStale(health('2026-09-01T00:00:00.000Z'), 'cloud', now)).toBe(false)
  })
  it('does not mark a local provider stale when it has never reported', () => {
    expect(isStale(health(), 'local', now)).toBe(false)
  })
})
