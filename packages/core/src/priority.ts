import type { TrackedQuota } from './alerts/use-or-lose.js'

export function sortByPriority(quotas: TrackedQuota[]): TrackedQuota[] {
  return [...quotas].sort(
    (a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt) || b.remainingFraction - a.remainingFraction,
  )
}
