import { describe, expect, it } from 'vitest'
import { freebuffProvider } from '../../src/providers/freebuff.js'
import { CLOUD_PROVIDERS } from '../../src/providers/registry.js'
import { NOW, ctx, fixture, jsonResponse, mockFetch } from './helpers.js'

const SESSION_URL = 'https://www.codebuff.com/api/v1/freebuff/session'

describe('freebuffProvider', () => {
  it('is registered as a cloud provider', () => {
    expect(CLOUD_PROVIDERS).toContain(freebuffProvider)
    expect(freebuffProvider.source).toBe('cloud')
  })

  it('round-trips the credential as a plain string', () => {
    expect(freebuffProvider.parseCredential(' tok \n')).toBe('tok')
    expect(freebuffProvider.serializeCredential('tok')).toBe('tok')
  })

  it('reads only the free daily Freebucks quota', async () => {
    const fetchFn = mockFetch(() => jsonResponse(fixture('freebuff/synthetic-session.json')))
    const { reading } = await freebuffProvider.read(ctx('tok', fetchFn))
    expect(reading).toEqual({
      provider: 'freebuff',
      ok: true,
      source: 'cloud',
      readAt: NOW.toISOString(),
      quotas: [
        {
          provider: 'freebuff',
          quotaId: 'freebucks-daily',
          name: 'Freebuff (gratis, diario)',
          window: 'daily',
          remainingFraction: 0.8,
          remaining: 4,
          total: 5,
          unit: 'Freebucks',
          resetsAt: '2026-10-24T07:00:00.000Z',
        },
      ],
    })
  })

  it('only ever issues a GET with no body', async () => {
    const fetchFn = mockFetch(() => jsonResponse(fixture('freebuff/synthetic-session.json')))
    await freebuffProvider.read(ctx('tok', fetchFn))
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]!
    expect(String(url)).toBe(SESSION_URL)
    expect((init!.method ?? 'GET').toUpperCase()).toBe('GET')
    expect(init!.body).toBeUndefined()
    expect(new Headers(init!.headers).get('authorization')).toBe('Bearer tok')
  })

  it('is unavailable when the daily quota is missing', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ freeWindows: { monthUsed: 1, monthLimit: 40 } }))
    const { reading } = await freebuffProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
  })

  it('reports malformed daily usage instead of falling back to monthly or weekly quotas', async () => {
    const fetchFn = mockFetch(() => jsonResponse({
      freebucks: { daily: { limit: 'bad', remaining: 2, resetAt: '2026-10-24T07:00:00Z' } },
      freeWindows: { monthUsed: 1, monthLimit: 40 },
    }))
    const { reading } = await freebuffProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
  })

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [503, 'network'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    const fetchFn = mockFetch(() => jsonResponse({ error: 'x' }, status))
    const { reading } = await freebuffProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind } })
  })

  it('maps a network failure to network without throwing', async () => {
    const fetchFn = mockFetch(() => {
      throw new Error('boom')
    })
    const { reading } = await freebuffProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'network' } })
  })
})
