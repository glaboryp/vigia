import { WINDOW_MS, isNewPeriod } from '../period.js'
import type { Quota } from '../types.js'
import type { TrackedQuota } from './use-or-lose.js'

export const CLOSE_RELIABILITY_TAIL = 0.1

export type QuotaTransition =
  | { kind: 'same-period' }
  | { kind: 'new-period'; closedFraction: number | null; closedPeriodResetAt: string }

export function classifyTransition(
  prev: TrackedQuota | undefined,
  next: Quota,
): QuotaTransition | { kind: 'first-seen' } {
  if (!prev) return { kind: 'first-seen' }
  if (!isNewPeriod(prev.periodResetAt, next.resetsAt, next.window)) return { kind: 'same-period' }
  const reliableFrom = Date.parse(prev.periodResetAt) - WINDOW_MS[next.window] * CLOSE_RELIABILITY_TAIL
  const reliable = Date.parse(prev.readAt) >= reliableFrom
  return {
    kind: 'new-period',
    closedFraction: reliable ? prev.remainingFraction : null,
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
