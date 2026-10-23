import { describe, expect, it } from 'vitest'
import { classifyTransition, isRenewalAlert } from '../src/alerts/renewed.js'
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
})
