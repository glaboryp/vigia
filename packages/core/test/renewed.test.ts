import { describe, expect, it } from 'vitest'
import { CLOSE_RELIABILITY_TAIL, classifyTransition, isRenewalAlert } from '../src/alerts/renewed.js'
import type { TrackedQuota } from '../src/alerts/use-or-lose.js'
import type { Quota } from '../src/types.js'

const OLD = '2026-10-16T10:00:00.000Z'
const NEW = '2026-10-23T10:00:00.000Z'

const prev = (remainingFraction: number): TrackedQuota => ({
  provider: 'codex',
  quotaId: 'weekly',
  name: 'Weekly',
  window: 'weekly',
  remainingFraction,
  resetsAt: OLD,
  periodResetAt: OLD,
  readAt: '2026-10-16T09:00:00.000Z',
})

const next = (remainingFraction: number, resetsAt: string): Quota => ({
  provider: 'codex',
  quotaId: 'weekly',
  name: 'Weekly',
  window: 'weekly',
  remainingFraction,
  resetsAt,
})

describe('renewal detection', () => {
  it('alerts when an exhausted quota enters a new period with quota', () => {
    expect(isRenewalAlert(prev(0), next(1, NEW))).toBe(true)
  })
  it('does not alert when the previous period closed with leftovers, but reports the closed fraction', () => {
    expect(isRenewalAlert(prev(0.3), next(1, NEW))).toBe(false)
    expect(classifyTransition(prev(0.3), next(1, NEW))).toEqual({
      kind: 'new-period',
      closedFraction: 0.3,
      closedPeriodResetAt: OLD,
    })
  })
  it('does not alert when quota returns within the same period (credit purchase)', () => {
    expect(classifyTransition(prev(0), next(0.2, OLD))).toEqual({ kind: 'same-period' })
    expect(isRenewalAlert(prev(0), next(0.2, OLD))).toBe(false)
  })
  it('treats a missing previous reading as first-seen without alert', () => {
    expect(classifyTransition(undefined, next(1, NEW))).toEqual({ kind: 'first-seen' })
    expect(isRenewalAlert(undefined, next(1, NEW))).toBe(false)
  })
  it('does not alert when the new period is still exhausted', () => {
    expect(isRenewalAlert(prev(0), next(0, NEW))).toBe(false)
  })
  it('classifies by periodResetAt even when prev.resetsAt drifted past it', () => {
    const drifted = { ...prev(0.5), resetsAt: '2026-10-20T10:00:00.000Z' }
    expect(classifyTransition(drifted, next(0.5, '2026-10-16T10:03:00.000Z'))).toEqual({ kind: 'same-period' })
  })
  it('exposes the reliability tail', () => {
    expect(CLOSE_RELIABILITY_TAIL).toBe(0.1)
  })
})

describe('close reliability', () => {
  const DAY = 86_400_000
  const monthlyPrev = (readDaysBefore: number, remainingFraction: number): TrackedQuota => ({
    ...prev(remainingFraction),
    window: 'monthly',
    readAt: new Date(Date.parse(OLD) - readDaysBefore * DAY).toISOString(),
  })
  const monthlyNext = (f: number): Quota => ({ ...next(f, '2026-11-16T10:00:00.000Z'), window: 'monthly' })

  it('returns a null closedFraction when the last reading is 20 days before the close', () => {
    expect(classifyTransition(monthlyPrev(20, 0.3), monthlyNext(1))).toMatchObject({
      kind: 'new-period',
      closedFraction: null,
    })
  })
  it('returns the fraction when the last reading is 1 day before the close', () => {
    expect(classifyTransition(monthlyPrev(1, 0.3), monthlyNext(1))).toMatchObject({
      kind: 'new-period',
      closedFraction: 0.3,
    })
  })
  it('still alerts renewal from a stale exhausted reading', () => {
    expect(isRenewalAlert(monthlyPrev(20, 0), monthlyNext(1))).toBe(true)
  })
})
