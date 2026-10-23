import type { Quota, Window } from './types.js'

const HOUR_MS = 3_600_000

export const WINDOW_MS: Record<Window, number> = {
  '5h': 5 * HOUR_MS,
  daily: 24 * HOUR_MS,
  weekly: 7 * 24 * HOUR_MS,
  monthly: 30 * 24 * HOUR_MS,
}

export function isNewPeriod(prevResetsAt: string, nextResetsAt: string, window: Window): boolean {
  return Date.parse(nextResetsAt) - Date.parse(prevResetsAt) > WINDOW_MS[window] / 2
}

export function periodKey(q: Pick<Quota, 'provider' | 'quotaId' | 'resetsAt'>): string {
  const rounded = Math.round(Date.parse(q.resetsAt) / HOUR_MS) * HOUR_MS
  return `${q.provider}:${q.quotaId}:${new Date(rounded).toISOString()}`
}
