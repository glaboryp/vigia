import { describe, expect, it } from 'vitest'
import { redact } from '../src/capture.js'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl'

describe('redact', () => {
  it('redacts sensitive keys', () => {
    expect(redact({ access_token: 'a', Password: 'b', userId: '1', plan: 'pro', used: 3 })).toEqual({
      access_token: 'REDACTED',
      Password: 'REDACTED',
      userId: 'REDACTED',
      plan: 'pro',
      used: 3,
    })
  })

  it('redacts emails and JWTs in values', () => {
    expect(redact({ note: 'me@example.com', blob: JWT, other: 'hello' })).toEqual({
      note: 'REDACTED',
      blob: 'REDACTED',
      other: 'hello',
    })
  })

  it('recurses into arrays and objects', () => {
    expect(redact({ items: [{ email: 'x', limit: 5 }, 'a@b.co', 7], nested: { deep: { secret: 1 } } })).toEqual({
      items: [{ email: 'REDACTED', limit: 5 }, 'REDACTED', 7],
      nested: { deep: { secret: 'REDACTED' } },
    })
  })

  it('keeps primitives', () => {
    expect(redact(null)).toBeNull()
    expect(redact(3)).toBe(3)
    expect(redact('plain')).toBe('plain')
  })
})
