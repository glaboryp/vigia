import { describe, expect, it } from 'vitest'
import { WINDOW_MS, isNewPeriod, periodKey } from '../src/period.js'

const at = (iso: string, deltaMs: number) => new Date(Date.parse(iso) + deltaMs).toISOString()
const MIN = 60_000
const DAY = 86_400_000
const BASE = '2026-10-23T10:00:00.000Z'

describe('isNewPeriod', () => {
  it('treats minutes of jitter on a weekly window as the same period', () => {
    expect(isNewPeriod(BASE, at(BASE, 3 * MIN), 'weekly')).toBe(false)
  })
  it('detects a weekly renewal', () => {
    expect(isNewPeriod(BASE, at(BASE, 7 * DAY), 'weekly')).toBe(true)
  })
  it('treats an advanced rolling reset on a weekly window as the same period', () => {
    expect(isNewPeriod(BASE, at(BASE, 2 * DAY), 'weekly')).toBe(false)
  })
  it('detects a monthly renewal', () => {
    expect(isNewPeriod(BASE, at(BASE, 31 * DAY), 'monthly')).toBe(true)
  })
  it('ignores a resetsAt that moves backwards', () => {
    expect(isNewPeriod(BASE, at(BASE, -DAY), 'monthly')).toBe(false)
  })
  it('exposes window lengths', () => {
    expect(WINDOW_MS).toEqual({ '5h': 5 * 3600_000, daily: DAY, weekly: 7 * DAY, monthly: 30 * DAY })
  })
})

describe('periodKey', () => {
  const key = (resetsAt: string) => periodKey({ provider: 'codex', quotaId: 'weekly', resetsAt })

  it('rounds resetsAt to the nearest UTC hour', () => {
    expect(key('2026-10-23T09:54:21Z')).toBe('codex:weekly:2026-10-23T10:00:00.000Z')
  })
  it('keeps the same key while the rounded hour is unchanged', () => {
    expect(key('2026-10-23T09:54:21Z')).toBe(key('2026-10-23T10:12:00Z'))
  })
  it('changes the key when the rounded hour changes', () => {
    expect(key('2026-10-23T10:12:00Z')).not.toBe(key('2026-10-23T10:40:00Z'))
  })
})
