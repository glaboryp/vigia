import { describe, expect, it } from 'vitest'
import { freebuffProvider } from '../../src/providers/freebuff.js'
import { CLOUD_PROVIDERS } from '../../src/providers/registry.js'
import { NOW, ctx, fixture, jsonResponse, mockFetch } from './helpers.js'

const SESSION_URL = 'https://codebuff.com/api/v1/freebuff/session'

const FREE = {
  dayUsed: 0,
  dayLimit: 5,
  weekUsed: 1,
  weekLimit: 10,
  monthUsed: 10,
  monthLimit: 40,
  dayResetAt: '2026-10-24T07:00:00Z',
  monthResetAt: '2026-11-01T07:00:00Z',
}

describe('freebuffProvider', () => {
  it('is registered as a cloud provider', () => {
    expect(CLOUD_PROVIDERS).toContain(freebuffProvider)
    expect(freebuffProvider.source).toBe('cloud')
  })

  it('round-trips the credential as a plain string', () => {
    expect(freebuffProvider.parseCredential(' tok \n')).toBe('tok')
    expect(freebuffProvider.serializeCredential('tok')).toBe('tok')
  })

  it('maps the free month and the subscription month, omitting day and week', async () => {
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
          quotaId: 'free-month',
          name: 'Freebuff (gratis)',
          window: 'monthly',
          remainingFraction: 1 - 12 / 40,
          remaining: 28,
          total: 40,
          unit: 'sesiones',
          resetsAt: '2026-11-01T07:00:00.000Z',
        },
        {
          provider: 'freebuff',
          quotaId: 'subscription-month',
          name: 'Freebuff (suscripción)',
          window: 'monthly',
          remainingFraction: 1 - 30 / 120,
          remaining: 90,
          total: 120,
          unit: 'sesiones',
          resetsAt: '2026-11-05T12:00:00.000Z',
        },
      ],
    })
    expect(reading.ok && reading.quotas.some((q) => q.window === 'daily' || q.window === 'weekly')).toBe(false)
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

  it('does not issue state-changing methods even on error paths', async () => {
    const fetchFn = mockFetch(() => jsonResponse({}, 401))
    await freebuffProvider.read(ctx('tok', fetchFn))
    for (const [, init] of fetchFn.mock.calls) expect((init!.method ?? 'GET').toUpperCase()).toBe('GET')
  })

  it('reads only the free month when there is no subscription', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ status: 'none', freeWindows: FREE, subscription: { tierId: null, tiers: [] } }))
    const { reading } = await freebuffProvider.read(ctx('t', fetchFn))
    expect(reading.ok && reading.quotas.map((q) => q.quotaId)).toEqual(['free-month'])
  })

  it('includes a weekly quota only when a weekly reset date is present', async () => {
    const withWeekReset = { ...FREE, weekResetAt: '2026-10-27T07:00:00Z' }
    const fetchFn = mockFetch(() => jsonResponse({ freeWindows: withWeekReset }))
    const { reading } = await freebuffProvider.read(ctx('t', fetchFn))
    expect(reading.ok && reading.quotas).toContainEqual({
      provider: 'freebuff',
      quotaId: 'free-week',
      name: 'Freebuff (gratis, semanal)',
      window: 'weekly',
      remainingFraction: 0.9,
      remaining: 9,
      total: 10,
      unit: 'sesiones',
      resetsAt: '2026-10-27T07:00:00.000Z',
    })
  })

  it('clamps overspent windows to zero', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ freeWindows: { ...FREE, monthUsed: 55 } }))
    const { reading } = await freebuffProvider.read(ctx('t', fetchFn))
    expect(reading.ok && reading.quotas[0]).toMatchObject({ remainingFraction: 0, remaining: 0 })
  })

  it('is unavailable when neither free windows nor a subscription are reported', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ status: 'queued' }))
    const { reading } = await freebuffProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
  })

  it('is a parse error when free windows are malformed', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ freeWindows: { monthUsed: 'x' } }))
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

  it('keeps the subscription when free windows are malformed', async () => {
    const sub = (await import('./helpers.js')).fixture('freebuff/synthetic-session.json') as { subscription: unknown }
    const fetchFn = mockFetch(() => jsonResponse({ freeWindows: { monthUsed: 'x' }, subscription: sub.subscription }))
    const { reading } = await freebuffProvider.read(ctx('t', fetchFn))
    expect(reading.ok && reading.quotas.map((q) => q.quotaId)).toEqual(['subscription-month'])
  })

  it('keeps the free month when the subscription has no reset date', async () => {
    const subscription = { tierId: 'pro', usage: { monthUsed: 1, monthLimit: 10 } }
    const fetchFn = mockFetch(() => jsonResponse({ freeWindows: FREE, subscription }))
    const { reading } = await freebuffProvider.read(ctx('t', fetchFn))
    expect(reading.ok && reading.quotas.map((q) => q.quotaId)).toEqual(['free-month'])
  })

  it('is a parse error when the subscription has no reset date and nothing else is usable', async () => {
    const subscription = { tierId: 'pro', usage: { monthUsed: 1, monthLimit: 10 } }
    const fetchFn = mockFetch(() => jsonResponse({ subscription }))
    const { reading } = await freebuffProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
  })
})
