import { describe, expect, it } from 'vitest'
import { DEFAULT_SURPLUS_CONFIG, findSurplus, type PeriodClose } from '../src/alerts/surplus.js'
import type { ProviderId, Window } from '../src/types.js'

const close = (
  used: number,
  month: number,
  over: Partial<{ provider: ProviderId; quotaId: string; window: Window }> = {},
): PeriodClose => ({
  provider: 'cursor',
  quotaId: 'monthly',
  window: 'monthly',
  periodResetAt: `2026-${String(month).padStart(2, '0')}-01T00:00:00.000Z`,
  usedFraction: used,
  ...over,
})

describe('findSurplus', () => {
  it('defaults to 0.4, 3 periods and every provider but freebuff', () => {
    expect(DEFAULT_SURPLUS_CONFIG.threshold).toBe(0.4)
    expect(DEFAULT_SURPLUS_CONFIG.periods).toBe(3)
    expect(DEFAULT_SURPLUS_CONFIG.paidProviders).toEqual([
      'copilot', 'cursor', 'kilo', 'qoder', 'mimo', 'opencode', 'grok', 'codex', 'antigravity',
    ])
  })
  it('detects three consecutive underused closes and averages them', () => {
    const res = findSurplus([close(0.2, 6), close(0.3, 7), close(0.35, 8)], DEFAULT_SURPLUS_CONFIG)
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({ provider: 'cursor', quotaId: 'monthly' })
    expect(res[0]!.avgUsed).toBeCloseTo(0.2833, 3)
  })
  it('does not flag when any of the last periods reaches the threshold', () => {
    expect(findSurplus([close(0.2, 6), close(0.5, 7), close(0.35, 8)], DEFAULT_SURPLUS_CONFIG)).toEqual([])
  })
  it('requires the full number of closes', () => {
    expect(findSurplus([close(0.2, 7), close(0.3, 8)], DEFAULT_SURPLUS_CONFIG)).toEqual([])
  })
  it('uses only the most recent closes, sorted by period', () => {
    const closes = [close(0.9, 4), close(0.3, 8), close(0.2, 6), close(0.1, 7)]
    expect(findSurplus(closes, DEFAULT_SURPLUS_CONFIG)).toHaveLength(1)
  })
  it('never flags freebuff', () => {
    const closes = [6, 7, 8].map((m) => close(0.1, m, { provider: 'freebuff' }))
    expect(findSurplus(closes, DEFAULT_SURPLUS_CONFIG)).toEqual([])
  })
  it('ignores non-monthly windows', () => {
    const closes = [6, 7, 8].map((m) => close(0.1, m, { window: 'weekly' }))
    expect(findSurplus(closes, DEFAULT_SURPLUS_CONFIG)).toEqual([])
  })
  it('groups by provider and quota', () => {
    const closes = [
      ...[6, 7, 8].map((m) => close(0.1, m)),
      ...[6, 7, 8].map((m) => close(0.9, m, { provider: 'codex' })),
    ]
    expect(findSurplus(closes, DEFAULT_SURPLUS_CONFIG).map((r) => r.provider)).toEqual(['cursor'])
  })
})
