import { describe, expect, it } from 'vitest'
import { qoderProvider } from '../../src/providers/qoder.js'
import { CLOUD_PROVIDERS } from '../../src/providers/registry.js'
import { NOW, ctx, fixture, jsonResponse, mockFetch } from './helpers.js'

const EXCHANGE = 'https://openapi.qoder.sh/api/v1/jobToken/exchange'
const V3 = 'https://openapi.qoder.sh/api/v3/user/status'
const V2 = 'https://openapi.qoder.sh/api/v2/quota/usage'
const CRED = { pat: 'pt-abc' }

function route(routes: Record<string, () => Response>) {
  return mockFetch((url) => {
    const handler = routes[url]
    if (!handler) throw new Error(`unexpected ${url}`)
    return handler()
  })
}

const exchangeOk = () => jsonResponse(fixture('qoder/synthetic-exchange.json'))

describe('qoderProvider', () => {
  it('is registered as a cloud provider', () => {
    expect(CLOUD_PROVIDERS).toContain(qoderProvider)
    expect(qoderProvider.source).toBe('cloud')
  })

  it('parses a raw PAT or JSON and serializes as JSON', () => {
    expect(qoderProvider.parseCredential(' pt-abc \n')).toEqual({ pat: 'pt-abc' })
    expect(qoderProvider.parseCredential('{"pat":"pt-xyz"}')).toEqual({ pat: 'pt-xyz' })
    expect(qoderProvider.parseCredential(qoderProvider.serializeCredential({ pat: 'pt-1' }))).toEqual({ pat: 'pt-1' })
    expect(() => qoderProvider.parseCredential('')).toThrow()
    expect(() => qoderProvider.parseCredential('{"x":1}')).toThrow()
  })

  it('exchanges the PAT then reads v3 status', async () => {
    const fetchFn = route({
      [EXCHANGE]: exchangeOk,
      [V3]: () => jsonResponse(fixture('qoder/synthetic-status-v3.json')),
    })
    const { reading } = await qoderProvider.read(ctx(CRED, fetchFn))
    expect(reading).toEqual({
      provider: 'qoder',
      ok: true,
      source: 'cloud',
      readAt: NOW.toISOString(),
      quotas: [
        {
          provider: 'qoder',
          quotaId: 'plan',
          name: 'Qoder',
          window: 'monthly',
          remainingFraction: 225 / 300,
          remaining: 225,
          total: 300,
          unit: 'créditos',
          resetsAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    const [exUrl, exInit] = fetchFn.mock.calls[0]!
    expect(String(exUrl)).toBe(EXCHANGE)
    expect(exInit!.method).toBe('POST')
    expect(JSON.parse(String(exInit!.body))).toEqual({ personal_token: 'pt-abc' })
    const [stUrl, stInit] = fetchFn.mock.calls[1]!
    expect(String(stUrl)).toBe(V3)
    expect(new Headers(stInit!.headers).get('authorization')).toBe('Bearer jt-synthetic-0001')
    expect(stInit!.method ?? 'GET').toBe('GET')
  })

  it('exchanges on every read', async () => {
    const fetchFn = route({
      [EXCHANGE]: exchangeOk,
      [V3]: () => jsonResponse(fixture('qoder/synthetic-status-v3.json')),
    })
    await qoderProvider.read(ctx(CRED, fetchFn))
    await qoderProvider.read(ctx(CRED, fetchFn))
    expect(fetchFn.mock.calls.filter(([u]) => String(u) === EXCHANGE)).toHaveLength(2)
  })

  it('falls back to v2 for the reset date when v3 has none', async () => {
    const fetchFn = route({
      [EXCHANGE]: exchangeOk,
      [V3]: () => jsonResponse(fixture('qoder/synthetic-status-v3-no-reset.json')),
      [V2]: () => jsonResponse(fixture('qoder/synthetic-usage-v2.json')),
    })
    const { reading } = await qoderProvider.read(ctx(CRED, fetchFn))
    expect(reading.ok && reading.quotas[0]).toMatchObject({
      remainingFraction: 0.75,
      remaining: 150,
      total: 200,
      resetsAt: '2026-11-20T00:00:00.000Z',
    })
    const v2Init = fetchFn.mock.calls[2]![1]!
    expect(new Headers(v2Init.headers).get('authorization')).toBe('Bearer jt-synthetic-0001')
  })

  it('uses v2 for quota and reset when v3 is not found', async () => {
    const fetchFn = route({
      [EXCHANGE]: exchangeOk,
      [V3]: () => jsonResponse({}, 404),
      [V2]: () => jsonResponse(fixture('qoder/synthetic-usage-v2.json')),
    })
    const { reading } = await qoderProvider.read(ctx(CRED, fetchFn))
    expect(reading.ok && reading.quotas[0]).toMatchObject({ remaining: 150, total: 200, resetsAt: '2026-11-20T00:00:00.000Z' })
  })

  it('is a parse error when neither endpoint gives a reset date', async () => {
    const fetchFn = route({
      [EXCHANGE]: exchangeOk,
      [V3]: () => jsonResponse(fixture('qoder/synthetic-status-v3-no-reset.json')),
      [V2]: () => jsonResponse({ data: {} }),
    })
    const { reading } = await qoderProvider.read(ctx(CRED, fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
  })

  it.each([401, 403])('maps exchange HTTP %i to auth without calling status', async (status) => {
    const fetchFn = route({ [EXCHANGE]: () => jsonResponse({ message: 'bad' }, status) })
    const { reading } = await qoderProvider.read(ctx(CRED, fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('maps a status 401 to auth', async () => {
    const fetchFn = route({ [EXCHANGE]: exchangeOk, [V3]: () => jsonResponse({}, 401) })
    const { reading } = await qoderProvider.read(ctx(CRED, fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
  })

  it('is a parse error when the exchange returns no job token', async () => {
    const fetchFn = route({ [EXCHANGE]: () => jsonResponse({ data: {} }) })
    const { reading } = await qoderProvider.read(ctx(CRED, fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
  })

  it('maps a 5xx exchange to network', async () => {
    const fetchFn = route({ [EXCHANGE]: () => jsonResponse({}, 503) })
    const { reading } = await qoderProvider.read(ctx(CRED, fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'network' } })
  })

  it('maps a network failure to network without throwing', async () => {
    const fetchFn = mockFetch(() => {
      throw new Error('boom')
    })
    const { reading } = await qoderProvider.read(ctx(CRED, fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'network' } })
  })
})
