import type { ProviderId, Window } from '../types.js'

export interface PeriodClose {
  provider: ProviderId
  quotaId: string
  window: Window
  periodResetAt: string
  usedFraction: number
}

export interface SurplusConfig {
  threshold: number
  periods: number
  paidProviders: ProviderId[]
}

export const DEFAULT_SURPLUS_CONFIG: SurplusConfig = {
  threshold: 0.4,
  periods: 3,
  paidProviders: ['copilot', 'cursor', 'kilo', 'qoder', 'mimo', 'opencode', 'grok', 'codex', 'antigravity'],
}

export function findSurplus(
  closes: PeriodClose[],
  cfg: SurplusConfig,
): { provider: ProviderId; quotaId: string; avgUsed: number }[] {
  const groups = new Map<string, Map<string, PeriodClose>>()
  for (const c of closes) {
    if (c.window !== 'monthly' || !cfg.paidProviders.includes(c.provider)) continue
    const key = `${c.provider}\u0000${c.quotaId}`
    const group = groups.get(key) ?? new Map<string, PeriodClose>()
    group.set(c.periodResetAt, c)
    groups.set(key, group)
  }

  const result: { provider: ProviderId; quotaId: string; avgUsed: number }[] = []
  for (const byPeriod of groups.values()) {
    const group = [...byPeriod.values()]
    if (group.length < cfg.periods) continue
    const recent = group
      .sort((a, b) => Date.parse(a.periodResetAt) - Date.parse(b.periodResetAt))
      .slice(-cfg.periods)
    if (!recent.every((c) => c.usedFraction < cfg.threshold)) continue
    const avgUsed = recent.reduce((sum, c) => sum + c.usedFraction, 0) / recent.length
    result.push({ provider: recent[0]!.provider, quotaId: recent[0]!.quotaId, avgUsed })
  }
  return result
}
