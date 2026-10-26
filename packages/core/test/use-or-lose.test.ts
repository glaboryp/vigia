import { describe, expect, it } from 'vitest'
import { USE_OR_LOSE_LEAD_MS, dueUseOrLose, useOrLoseKey, type TrackedQuota } from '../src/alerts/use-or-lose.js'
import { sortByPriority } from '../src/priority.js'
import { periodKey } from '../src/period.js'
import type { Window } from '../src/types.js'

const NOW = new Date('2026-10-23T12:00:00.000Z')
const HOUR = 3_600_000
const inHours = (h: number) => new Date(NOW.getTime() + h * HOUR).toISOString()

function quota(over: Partial<TrackedQuota> & { window?: Window } = {}): TrackedQuota {
  const resetsAt = over.resetsAt ?? inHours(20)
  return {
    provider: 'codex',
    quotaId: 'q',
    name: 'Q',
    window: 'weekly',
    remainingFraction: 0.06,
    resetsAt,
    periodResetAt: resetsAt,
    readAt: NOW.toISOString(),
    ...over,
  }
}

const due = (qs: TrackedQuota[], sent = new Set<string>()) => dueUseOrLose(qs, NOW, sent)

describe('dueUseOrLose', () => {
  it('defines leads for weekly and monthly only', () => {
    expect(USE_OR_LOSE_LEAD_MS).toEqual({ weekly: 24 * HOUR, monthly: 4 * 24 * HOUR })
  })
  it('includes weekly 6% resetting in 20 h and excludes it at 30 h', () => {
    expect(due([quota()])).toHaveLength(1)
    expect(due([quota({ resetsAt: inHours(30) })])).toHaveLength(0)
  })
  it('includes monthly quota exactly 4 days before reset and excludes it at 5 days', () => {
    const m = { window: 'monthly' as const, remainingFraction: 0.5 }
    expect(due([quota({ ...m, resetsAt: inHours(4 * 24) })])).toHaveLength(1)
    expect(due([quota({ ...m, resetsAt: inHours(5 * 24) })])).toHaveLength(0)
  })
  it('excludes exhausted quotas', () => {
    expect(due([quota({ remainingFraction: 0 })])).toHaveLength(0)
  })
  it('excludes 5h and daily windows', () => {
    expect(due([quota({ window: '5h', resetsAt: inHours(1) })])).toHaveLength(0)
    expect(due([quota({ window: 'daily', resetsAt: inHours(1) })])).toHaveLength(0)
  })
  it('excludes stale data whose resetsAt is already past', () => {
    expect(due([quota({ resetsAt: inHours(-2) })])).toHaveLength(0)
  })
  it('excludes quotas whose full prefixed key is in alreadySent', () => {
    const q = quota()
    expect(useOrLoseKey(q)).toBe(`useorlose:${periodKey({ provider: q.provider, quotaId: q.quotaId, resetsAt: q.periodResetAt })}`)
    expect(due([q], new Set([useOrLoseKey(q)]))).toHaveLength(0)
  })
  it('does not treat the unprefixed period key as already sent', () => {
    const q = quota()
    const raw = periodKey({ provider: q.provider, quotaId: q.quotaId, resetsAt: q.periodResetAt })
    expect(due([q], new Set([raw]))).toHaveLength(1)
  })
  it('keys on periodResetAt so resetsAt jitter does not re-trigger', () => {
    const first = quota()
    const jittered = quota({ resetsAt: inHours(20.05), periodResetAt: first.periodResetAt })
    expect(useOrLoseKey(jittered)).toBe(useOrLoseKey(first))
  })
  it('orders by earliest reset, then by larger remaining fraction', () => {
    const a = quota({ quotaId: 'A', resetsAt: inHours(10), remainingFraction: 0.05 })
    const b = quota({ quotaId: 'B', resetsAt: inHours(10), remainingFraction: 0.4 })
    const c = quota({ quotaId: 'C', window: 'monthly', resetsAt: inHours(72), remainingFraction: 0.9 })
    expect(due([c, a, b]).map((q) => q.quotaId)).toEqual(['B', 'A', 'C'])
    expect(sortByPriority([c, a, b]).map((q) => q.quotaId)).toEqual(['B', 'A', 'C'])
  })
})
