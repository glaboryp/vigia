import { describe, expect, it } from 'vitest'
import { copilotProvider } from '../../src/providers/copilot.js'
import { CLOUD_PROVIDERS } from '../../src/providers/registry.js'
import { NOW, ctx, fixture, jsonResponse, mockFetch } from './helpers.js'

const USER_URL = 'https://api.github.com/copilot_internal/user'

function snapshots(premium: unknown, extra: Record<string, unknown> = {}) {
  return { quota_reset_date_utc: '2026-11-01T00:00:00Z', quota_snapshots: { premium_interactions: premium }, ...extra }
}

describe('copilotProvider', () => {
  it('is registered as a cloud provider', () => {
    expect(CLOUD_PROVIDERS).toContain(copilotProvider)
    expect(copilotProvider.source).toBe('cloud')
  })

  it('round-trips the credential as a plain string', () => {
    expect(copilotProvider.parseCredential(' gho_abc \n')).toBe('gho_abc')
    expect(copilotProvider.serializeCredential('gho_abc')).toBe('gho_abc')
  })

  it('maps the premium_interactions snapshot to a monthly quota', async () => {
    const fetchFn = mockFetch(() => jsonResponse(fixture('copilot/synthetic-user.json')))
    const { reading } = await copilotProvider.read(ctx('gho_abc', fetchFn))
    expect(reading).toEqual({
      provider: 'copilot',
      ok: true,
      source: 'cloud',
      readAt: NOW.toISOString(),
      quotas: [
        {
          provider: 'copilot',
          quotaId: 'premium',
          name: 'Premium',
          window: 'monthly',
          remainingFraction: 0.8,
          remaining: 240,
          total: 300,
          unit: 'créditos',
          resetsAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    })
    const [url, init] = fetchFn.mock.calls[0]!
    expect(String(url)).toBe(USER_URL)
    const headers = new Headers(init!.headers)
    expect(headers.get('authorization')).toBe('token gho_abc')
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('user-agent')).toBe('VigIA')
    expect(headers.get('editor-version')).toBeTruthy()
    expect(init!.method ?? 'GET').toBe('GET')
  })

  it('derives the fraction when percent_remaining is missing', async () => {
    const fetchFn = mockFetch(() => jsonResponse(snapshots({ entitlement: '300', remaining: '75' })))
    const { reading } = await copilotProvider.read(ctx('t', fetchFn))
    expect(reading.ok && reading.quotas[0]!.remainingFraction).toBe(0.25)
  })

  it('falls back to quota_reset_date when the UTC field is absent', async () => {
    const fetchFn = mockFetch(() =>
      jsonResponse({ quota_reset_date: '2026-11-01', quota_snapshots: { premium_interactions: { percent_remaining: 40 } } }),
    )
    const { reading } = await copilotProvider.read(ctx('t', fetchFn))
    expect(reading.ok && reading.quotas[0]).toMatchObject({ remainingFraction: 0.4, resetsAt: '2026-11-01T00:00:00.000Z' })
    expect(reading.ok && reading.quotas[0]!.total).toBeUndefined()
  })

  it('returns no quotas for an unlimited plan', async () => {
    const fetchFn = mockFetch(() => jsonResponse(snapshots({ unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100 })))
    const { reading } = await copilotProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: true, quotas: [] })
  })

  it('is unavailable when premium_interactions is missing', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ quota_snapshots: { chat: { percent_remaining: 50 } } }))
    const { reading } = await copilotProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
  })

  it('is a parse error when the reset date is missing or unusable', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ quota_snapshots: { premium_interactions: { percent_remaining: 40 } } }))
    const { reading } = await copilotProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
  })

  it('is a parse error when no fraction can be computed', async () => {
    const fetchFn = mockFetch(() => jsonResponse(snapshots({ unlimited: false, quota_id: 'premium_interactions' })))
    const { reading } = await copilotProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
  })

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [500, 'network'],
    [404, 'unavailable'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    const fetchFn = mockFetch(() => jsonResponse({ message: 'x' }, status))
    const { reading } = await copilotProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind } })
  })

  it('maps a network failure to network without throwing', async () => {
    const fetchFn = mockFetch(() => {
      throw new Error('boom')
    })
    const { reading } = await copilotProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'network' } })
  })

  it('maps a non-JSON body to parse', async () => {
    const fetchFn = mockFetch(() => jsonResponse('<html>', 200))
    const { reading } = await copilotProvider.read(ctx('t', fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
  })
})
