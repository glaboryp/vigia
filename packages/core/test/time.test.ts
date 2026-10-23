import { describe, expect, it } from 'vitest'
import { formatMadrid, formatRelative } from '../src/time.js'

describe('formatMadrid', () => {
  it('uses winter time', () => {
    expect(formatMadrid('2026-10-26T09:54:21Z')).toBe('lun 26 oct, 10:54')
  })
  it('uses summer time', () => {
    expect(formatMadrid('2026-07-01T07:00:00Z')).toBe('mié 1 jul, 09:00')
  })
})

describe('formatRelative', () => {
  it('formats days and hours', () => {
    expect(formatRelative('2026-10-23T17:00:00Z', '2026-10-26T09:54:21Z')).toBe('en 2 d 16 h')
  })
  it('formats minutes', () => {
    const a = Date.parse('2026-10-23T17:00:00Z')
    expect(formatRelative(new Date(a).toISOString(), new Date(a + 40 * 60000).toISOString())).toBe('en 40 min')
  })
  it('formats hours', () => {
    const a = Date.parse('2026-10-23T17:00:00Z')
    expect(formatRelative(new Date(a).toISOString(), new Date(a + 310 * 60000).toISOString())).toBe('en 5 h')
  })
})
