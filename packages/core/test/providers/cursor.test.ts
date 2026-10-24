import { describe, expect, it } from 'vitest'
import { cursorProvider, type CursorCredential } from '../../src/providers/cursor.js'
import { CLOUD_PROVIDERS } from '../../src/providers/registry.js'
import { NOW, ctx, fixture, jsonResponse, mockFetch } from './helpers.js'

const URL_SUMMARY = 'https://cursor.com/api/usage-summary'

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'HS256' })}.${enc(claims)}.sig`
}

const exp = (offsetSeconds: number) => Math.floor(NOW.getTime() / 1000) + offsetSeconds
const VALID: CursorCredential = { accessToken: jwt({ sub: 'auth0|user_01ABC', exp: exp(3600) }) }

async function run(body: unknown, status = 200, cred = VALID) {
  const f = mockFetch(() => jsonResponse(body, status))
  const { reading } = await cursorProvider.read(ctx(cred, f))
  return { reading, f }
}

describe('cursorProvider', () => {
  it('is a cloud provider registered in CLOUD_PROVIDERS', () => {
    expect(cursorProvider.source).toBe('cloud')
    expect(CLOUD_PROVIDERS).toContain(cursorProvider)
  })

  it('reads a monthly cycle and sends the session cookie', async () => {
    const { reading, f } = await run(fixture('cursor/synthetic-monthly.json'))
    expect(reading).toMatchObject({ ok: true, source: 'cloud' })
    if (!reading.ok) return
    expect(reading.quotas).toEqual([
      {
        provider: 'cursor',
        quotaId: 'plan',
        name: 'Plan',
        window: 'monthly',
        remainingFraction: 0.84,
        remaining: 42,
        total: 50,
        unit: 'USD',
        resetsAt: '2026-11-01T00:00:00.000Z',
      },
    ])
    const [url, init] = f.mock.calls[0]!
    expect(String(url)).toBe(URL_SUMMARY)
    const headers = init!.headers as Record<string, string>
    expect(headers.Cookie).toBe(`WorkosCursorSessionToken=user_01ABC%3A%3A${VALID.accessToken}`)
    expect(headers.Origin).toBe('https://cursor.com')
    expect(headers.Referer).toBe('https://cursor.com')
  })

  it('uses a weekly window for a 7 day cycle', async () => {
    const { reading } = await run(fixture('cursor/synthetic-weekly.json'))
    if (!reading.ok) throw new Error('expected ok')
    expect(reading.quotas[0]).toMatchObject({ window: 'weekly', remainingFraction: 0.75 })
  })

  it('derives the fraction from cents when percentages are missing', async () => {
    const { reading } = await run(fixture('cursor/synthetic-cents-only.json'))
    if (!reading.ok) throw new Error('expected ok')
    expect(reading.quotas[0]).toMatchObject({ remainingFraction: 0.75, remaining: 37.5, total: 50, unit: 'USD' })
  })

  it('reports unlimited plans as an ok reading without quotas', async () => {
    const { reading } = await run(fixture('cursor/synthetic-unlimited.json'))
    expect(reading).toMatchObject({ ok: true, quotas: [] })
  })

  it('returns auth without any request for an expired JWT', async () => {
    const cred = { accessToken: jwt({ sub: 'auth0|user_01ABC', exp: exp(-10) }) }
    const { reading, f } = await run(fixture('cursor/synthetic-monthly.json'), 200, cred)
    expect(reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(f).not.toHaveBeenCalled()
  })

  it('returns auth for a JWT without sub', async () => {
    const { reading, f } = await run({}, 200, { accessToken: jwt({ exp: exp(60) }) })
    expect(reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(f).not.toHaveBeenCalled()
  })

  it.each([401, 403])('maps HTTP %i to auth', async (status) => {
    const { reading } = await run({}, status)
    expect(reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
  })

  it('maps HTTP 500 to network', async () => {
    const { reading } = await run({}, 500)
    expect(reading).toMatchObject({ ok: false, error: { kind: 'network' } })
  })

  it('maps an unexpected shape to parse', async () => {
    expect((await run([1, 2])).reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
    const noEnd = { individualUsage: { plan: { totalPercentUsed: 10 } } }
    expect((await run(noEnd)).reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
  })

  it('maps a summary without any usage to unavailable', async () => {
    const { reading } = await run({ billingCycleEnd: '2026-11-01T00:00:00Z', individualUsage: {} })
    expect(reading).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
  })

  it('parses the raw JWT or JSON credentials', () => {
    expect(cursorProvider.parseCredential(` ${VALID.accessToken}\n`)).toEqual(VALID)
    expect(cursorProvider.parseCredential(JSON.stringify(VALID))).toEqual(VALID)
    expect(cursorProvider.parseCredential(JSON.stringify({ access_token: VALID.accessToken }))).toEqual(VALID)
    expect(() => cursorProvider.parseCredential('{}')).toThrow()
    expect(() => cursorProvider.parseCredential('')).toThrow()
    expect(cursorProvider.parseCredential(cursorProvider.serializeCredential(VALID))).toEqual(VALID)
  })
})
