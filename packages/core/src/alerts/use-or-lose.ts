import { periodKey } from '../period.js'
import { sortByPriority } from '../priority.js'
import type { Quota, Window } from '../types.js'

export interface TrackedQuota extends Quota {
  periodResetAt: string
  readAt: string
}

const HOUR_MS = 3_600_000

export const USE_OR_LOSE_LEAD_MS: Partial<Record<Window, number>> = {
  weekly: 24 * HOUR_MS,
  monthly: 7 * 24 * HOUR_MS,
}

export function useOrLoseKey(q: TrackedQuota): string {
  return `useorlose:${periodKey({ provider: q.provider, quotaId: q.quotaId, resetsAt: q.periodResetAt })}`
}

export function dueUseOrLose(quotas: TrackedQuota[], now: Date, alreadySent: Set<string>): TrackedQuota[] {
  const due = quotas.filter((q) => {
    const lead = USE_OR_LOSE_LEAD_MS[q.window]
    if (lead === undefined || q.remainingFraction <= 0) return false
    const untilReset = Date.parse(q.resetsAt) - now.getTime()
    return untilReset > 0 && untilReset <= lead && !alreadySent.has(useOrLoseKey(q))
  })
  return sortByPriority(due)
}
