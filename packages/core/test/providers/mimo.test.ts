import { describe, expect, it } from 'vitest'
import { mimoProvider, madridOffset } from '../../src/providers/mimo.js'
import { LOCAL_HTTP_PROVIDERS } from '../../src/providers/registry.js'
import { ctx, fixture, jsonResponse, mockFetch } from './helpers.js'

const BASE = 'https://platform.xiaomimimo.com/api/v1/tokenPlan'
const CRED = { cookie: 'api-platform_serviceToken=abc; userId=42' }

function route(overrides: { usage?: () => Response; detail?: () => Response } = {}) {
  return mockFetch((url) => {
    if (url === `${BASE}/usage`) return overrides.usage?.() ?? jsonResponse(fixture('mimo/synthetic-usage.json'))
    if (url === `${BASE}/detail`) return overrides.detail?.() ?? jsonResponse(fixture('mimo/synthetic-detail.json'))
    return new Response('nope', { status: 404 })
  })
}

async function read(f = route()) {
  const { reading } = await mimoProvider.read(ctx(CRED, f))
  return { reading, f }
}

describe('mimoProvider', () => {
  it('is a local provider registered in LOCAL_HTTP_PROVIDERS', () => {
    expect(mimoProvider.source).toBe('local')
    expect(LOCAL_HTTP_PROVIDERS).toContain(mimoProvider)
  })

  it('reads the monthly token plan', async () => {
    const { reading, f } = await read()
    expect(reading).toMatchObject({ ok: true, source: 'local' })
    if (!reading.ok) return
    expect(reading.quotas).toHaveLength(1)
    const quota = reading.quotas[0]!
    expect(quota).toMatchObject({
      provider: 'mimo',
      quotaId: 'month_total_token',
      window: 'monthly',
      remaining: 200000000 - 10100158,
      total: 200000000,
      unit: 'créditos',
      resetsAt: '2026-11-04T21:59:59.000Z',
    })
    expect(quota.remainingFraction).toBeCloseTo(1 - 10100158 / 200000000, 10)
    for (const [, init] of f.mock.calls) {
      const headers = init!.headers as Record<string, string>
      expect(headers.Cookie).toBe(CRED.cookie)
      expect(headers.Origin).toBe('https://platform.xiaomimimo.com')
      expect(headers.Referer).toBe('https://platform.xiaomimimo.com/#/console/balance')
      expect(headers['x-timeZone']).toBe('UTC+02:00')
      expect(headers['User-Agent']).toMatch(/Mozilla/)
      expect(init!.redirect).toBe('manual')
    }
  })

  it.each([401, 403])('maps body code %i on HTTP 200 to auth', async (code) => {
    const { reading } = await read(route({ usage: () => jsonResponse({ code, message: 'unauthorized' }) }))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
  })

  it('maps a redirect to auth', async () => {
    const f = route({ detail: () => new Response(null, { status: 302, headers: { location: 'https://x/login' } }) })
    expect((await read(f)).reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
  })

  it.each([401, 403])('maps HTTP %i to auth', async (status) => {
    const f = route({ usage: () => jsonResponse({}, status) })
    expect((await read(f)).reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
  })

  it('maps HTTP 502 to network', async () => {
    const f = route({ usage: () => jsonResponse({}, 502) })
    expect((await read(f)).reading).toMatchObject({ ok: false, error: { kind: 'network' } })
  })

  it('maps an expired plan to unavailable', async () => {
    const detail = { code: 0, data: { planCode: 'standard', currentPeriodEnd: '2026-10-01 00:00:00', expired: true } }
    const f = route({ detail: () => jsonResponse(detail) })
    expect((await read(f)).reading).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
  })

  it('maps an unexpected shape to parse', async () => {
    for (const usage of [{ code: 0, data: {} }, { code: 0, data: { monthUsage: { items: [] } } }, [1]]) {
      const f = route({ usage: () => jsonResponse(usage) })
      expect((await read(f)).reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
    }
    const f = route({ detail: () => jsonResponse({ code: 0, data: { expired: false } }) })
    expect((await read(f)).reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
  })

  it('parses raw cookie or JSON credentials', () => {
    expect(mimoProvider.parseCredential(' api-platform_serviceToken=abc; userId=42 ')).toEqual(CRED)
    expect(mimoProvider.parseCredential(JSON.stringify(CRED))).toEqual(CRED)
    expect(() => mimoProvider.parseCredential('  ')).toThrow()
    expect(mimoProvider.parseCredential(mimoProvider.serializeCredential(CRED))).toEqual(CRED)
  })

  it('computes the Madrid UTC offset including daylight saving', () => {
    expect(madridOffset(new Date('2026-01-15T12:00:00Z'))).toBe('+01:00')
    expect(madridOffset(new Date('2026-07-15T12:00:00Z'))).toBe('+02:00')
  })
})
