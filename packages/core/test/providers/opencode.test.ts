import { describe, expect, it } from 'vitest'
import { opencodeProvider } from '../../src/providers/opencode.js'
import { LOCAL_HTTP_PROVIDERS } from '../../src/providers/registry.js'
import { ctx, fixture, jsonResponse, mockFetch } from './helpers.js'

const ORGS = 'https://opencode.ai/console/api/orgs'
const STATUS = 'https://opencode.ai/console/api/go/status'
const CRED = { cookie: '__Host-console_session=abc' }

function route(overrides: { orgs?: () => Response; status?: () => Response } = {}) {
  return mockFetch((url) => {
    if (url === ORGS) return overrides.orgs?.() ?? jsonResponse(fixture('opencode/synthetic-orgs.json'))
    if (url === STATUS) return overrides.status?.() ?? jsonResponse(fixture('opencode/synthetic-go-status.json'))
    return new Response('nope', { status: 404 })
  })
}

async function read(f = route()) {
  const { reading } = await opencodeProvider.read(ctx(CRED, f))
  return { reading, f }
}

describe('opencodeProvider', () => {
  it('is a local provider registered in LOCAL_HTTP_PROVIDERS', () => {
    expect(opencodeProvider.source).toBe('local')
    expect(LOCAL_HTTP_PROVIDERS).toContain(opencodeProvider)
  })

  it('reads 5h, weekly and monthly meters in USD', async () => {
    const { reading, f } = await read()
    expect(reading).toMatchObject({ ok: true, source: 'local' })
    if (!reading.ok) return
    expect(reading.quotas).toEqual([
      { provider: 'opencode', quotaId: '5h', name: '5 horas', window: '5h', remainingFraction: 0.75, remaining: 9, total: 12, unit: 'USD', resetsAt: '2026-10-23T14:00:00.000Z' },
      { provider: 'opencode', quotaId: 'weekly', name: 'Semanal', window: 'weekly', remainingFraction: 0.6, remaining: 18, total: 30, unit: 'USD', resetsAt: '2026-10-26T00:00:00.000Z' },
      { provider: 'opencode', quotaId: 'monthly', name: 'Mensual', window: 'monthly', remainingFraction: 0.9, remaining: 54, total: 60, unit: 'USD', resetsAt: '2026-11-19T00:00:00.000Z' },
    ])
    const [, orgInit] = f.mock.calls[0]!
    const [statusUrl, statusInit] = f.mock.calls[1]!
    expect(String(statusUrl)).toBe(STATUS)
    const headers = statusInit!.headers as Record<string, string>
    expect(headers['x-org-id']).toBe('wrk_SYNTHETICONE')
    expect(headers.Cookie).toBe(CRED.cookie)
    expect(headers['User-Agent']).toMatch(/Mozilla/)
    expect((orgInit!.headers as Record<string, string>).Cookie).toBe(CRED.cookie)
    expect(statusInit!.redirect).toBe('manual')
  })

  it('skips a meter with no reset time', async () => {
    const status = fixture('opencode/synthetic-go-status.json') as any
    status.access.meters.fiveHour.resetsAt = null
    const { reading } = await read(route({ status: () => jsonResponse(status) }))
    if (!reading.ok) throw new Error('expected ok')
    expect(reading.quotas.map((q) => q.quotaId)).toEqual(['weekly', 'monthly'])
  })

  it.each([null, { access: null }])('maps no Go subscription (%j) to unavailable', async (body) => {
    const { reading } = await read(route({ status: () => jsonResponse(body === null ? 'null' : body) }))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
  })

  it('maps an empty org list to unavailable', async () => {
    const { reading } = await read(route({ orgs: () => jsonResponse([]) }))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
  })

  it.each([401, 403])('maps HTTP %i to auth', async (status) => {
    expect((await read(route({ orgs: () => jsonResponse({}, status) }))).reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect((await read(route({ status: () => jsonResponse({}, status) }))).reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
  })

  it('maps a redirect to auth', async () => {
    const orgs = () => new Response(null, { status: 302, headers: { location: '/auth' } })
    expect((await read(route({ orgs }))).reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
  })

  it('maps HTTP 503 to network', async () => {
    expect((await read(route({ status: () => jsonResponse({}, 503) }))).reading).toMatchObject({ ok: false, error: { kind: 'network' } })
  })

  it('maps an unexpected shape to parse', async () => {
    for (const status of [{ access: {} }, { access: { meters: {} } }, { access: { meters: { week: { resetsAt: '2026-10-26T00:00:00Z', usedMicroCents: '1' } } } }, [1]]) {
      expect((await read(route({ status: () => jsonResponse(status) }))).reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
    }
    expect((await read(route({ orgs: () => jsonResponse({ id: 'x' }) }))).reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
  })

  it('parses raw cookie or JSON credentials', () => {
    expect(opencodeProvider.parseCredential(' __Host-console_session=abc ')).toEqual(CRED)
    expect(opencodeProvider.parseCredential(JSON.stringify(CRED))).toEqual(CRED)
    expect(opencodeProvider.parseCredential('Cookie: __Host-console_session=abc')).toEqual(CRED)
    expect(() => opencodeProvider.parseCredential('')).toThrow()
  })
})
