import { describe, expect, it } from 'vitest'
import { kiloProvider } from '../../src/providers/kilo.js'
import { CLOUD_PROVIDERS } from '../../src/providers/registry.js'
import { NOW, ctx, fixture, jsonResponse, mockFetch } from './helpers.js'

function batch(json: unknown) {
  return [{ result: { data: { json } } }]
}

const ACTIVE = {
  status: 'active',
  currentPeriodBaseCreditsUsd: 20,
  currentPeriodBonusCreditsUsd: 5,
  currentPeriodUsageUsd: 5,
  nextBillingAt: '2026-11-12T08:30:00Z',
}

describe('kiloProvider', () => {
  it('is registered as a cloud provider', () => {
    expect(CLOUD_PROVIDERS).toContain(kiloProvider)
    expect(kiloProvider.source).toBe('cloud')
  })

  it('round-trips the credential as a plain string', () => {
    expect(kiloProvider.parseCredential(' tok \n')).toBe('tok')
    expect(kiloProvider.serializeCredential('tok')).toBe('tok')
  })

  it('maps the Kilo Pass state to a monthly USD quota', async () => {
    const fetchFn = mockFetch(() => jsonResponse(fixture('kilo/synthetic-pass-state.json')))
    const { reading } = await kiloProvider.read(ctx('tok', fetchFn))
    expect(reading).toEqual({
      provider: 'kilo',
      ok: true,
      source: 'cloud',
      readAt: NOW.toISOString(),
      quotas: [
        {
          provider: 'kilo',
          quotaId: 'pass',
          name: 'Kilo Pass',
          window: 'monthly',
          remainingFraction: 20 / 25,
          remaining: 20,
          total: 25,
          unit: 'USD',
          resetsAt: '2026-11-12T08:30:00.000Z',
        },
      ],
    })
    const [url, init] = fetchFn.mock.calls[0]!
    const parsed = new URL(String(url))
    expect(parsed.origin + parsed.pathname).toBe('https://app.kilo.ai/api/trpc/kiloPass.getState')
    expect(parsed.searchParams.get('batch')).toBe('1')
    expect(JSON.parse(parsed.searchParams.get('input')!)).toEqual({ 0: { json: null, meta: { values: ['undefined'] } } })
    expect(String(url)).toContain(encodeURIComponent('{"0":{"json":null,"meta":{"values":["undefined"]}}}'))
    expect(new Headers(init!.headers).get('authorization')).toBe('Bearer tok')
    expect(init!.method ?? 'GET').toBe('GET')
  })

  it('falls back to nextRenewalAt and clamps remaining at zero', async () => {
    const state = { ...ACTIVE, nextBillingAt: undefined, nextRenewalAt: 1795000000, currentPeriodUsageUsd: 30 }
    const fetchFn = mockFetch(() => jsonResponse(batch(state)))
    const { reading } = await kiloProvider.read(ctx('t', fetchFn))
    expect(reading.ok && reading.quotas[0]).toMatchObject({
      remaining: 0,
      remainingFraction: 0,
      resetsAt: new Date(1795000000 * 1000).toISOString(),
    })
  })

  it('accepts trialing and past_due as active', async () => {
    for (const status of ['trialing', 'past_due']) {
      const fetchFn = mockFetch(() => jsonResponse(batch({ ...ACTIVE, status })))
      const { reading } = await kiloProvider.read(ctx('t', fetchFn))
      expect(reading.ok).toBe(true)
    }
  })

  it.each([
    ['canceled status', batch({ ...ACTIVE, status: 'canceled' })],
    ['null state', batch(null)],
    ['empty state', batch({})],
    ['null subscription', batch({ subscription: null })],
  ])('is unavailable without an active pass (%s)', async (_n, body) => {
    const fetchFn = mockFetch(() => jsonResponse(body))
    const { reading } = await kiloProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'unavailable', message: 'Sin Kilo Pass activo' } })
  })

  it('reads a nested subscription object', async () => {
    const fetchFn = mockFetch(() => jsonResponse(batch({ subscription: ACTIVE })))
    const { reading } = await kiloProvider.read(ctx('t', fetchFn))
    expect(reading.ok && reading.quotas[0]!.total).toBe(25)
  })

  it('is a parse error when an active pass lacks a reset date', async () => {
    const fetchFn = mockFetch(() => jsonResponse(batch({ ...ACTIVE, nextBillingAt: undefined })))
    const { reading } = await kiloProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
  })

  it('is a parse error for an unexpected envelope', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ nope: true }))
    const { reading } = await kiloProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
  })

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [502, 'network'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    const fetchFn = mockFetch(() => jsonResponse([{ error: { json: { message: 'x' } } }], status))
    const { reading } = await kiloProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind } })
  })

  it('maps a tRPC UNAUTHORIZED error inside a 200 batch to auth', async () => {
    const body = [{ error: { json: { message: 'no', data: { code: 'UNAUTHORIZED', httpStatus: 401 } } } }]
    const fetchFn = mockFetch(() => jsonResponse(body))
    const { reading } = await kiloProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
  })

  it('maps a network failure to network without throwing', async () => {
    const fetchFn = mockFetch(() => {
      throw new Error('boom')
    })
    const { reading } = await kiloProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'network' } })
  })
})
