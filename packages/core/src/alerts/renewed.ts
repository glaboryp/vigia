import { isNewPeriod } from '../period.js'
import type { Quota } from '../types.js'
import type { TrackedQuota } from './use-or-lose.js'

export type QuotaTransition =
  | { kind: 'same-period' }
  | { kind: 'new-period'; closedFraction: number; closedPeriodResetAt: string }

export function classifyTransition(
  prev: TrackedQuota | undefined,
  next: Quota,
): QuotaTransition | { kind: 'first-seen' } {
  if (!prev) return { kind: 'first-seen' }
  if (!isNewPeriod(prev.periodResetAt, next.resetsAt, next.window)) return { kind: 'same-period' }
  return {
    kind: 'new-period',
    closedFraction: prev.remainingFraction,
    closedPeriodResetAt: prev.periodResetAt,
  }
}

export function isRenewalAlert(prev: TrackedQuota | undefined, next: Quota): boolean {
  return (
    classifyTransition(prev, next).kind === 'new-period' &&
    prev !== undefined &&
    prev.remainingFraction === 0 &&
    next.remainingFraction > 0
  )
}
