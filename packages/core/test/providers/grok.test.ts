import { describe, expect, it } from 'vitest'
import { grokProvider, type GrokCredential } from '../../src/providers/grok.js'
import { CLOUD_PROVIDERS } from '../../src/providers/registry.js'
import { NOW, ctx, fixture, jsonResponse, mockFetch } from './helpers.js'

const BILLING_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig'
const TOKEN_URL = 'https://auth.x.ai/oauth2/token'
const PERIOD_END = 1793100000
const SCOPE = 'https://auth.x.ai::synthetic-user'

function varint(value: number | bigint): number[] {
  let n = BigInt(value)
  const out: number[] = []
  do {
    const byte = Number(n & 0x7fn)
    n >>= 7n
    out.push(n > 0n ? byte | 0x80 : byte)
  } while (n > 0n)
  return out
}

const key = (field: number, wire: number) => varint((field << 3) | wire)
const lenField = (field: number, payload: number[]) => [...key(field, 2), ...varint(payload.length), ...payload]
const varintField = (field: number, value: number) => [...key(field, 0), ...varint(value)]
const floatField = (field: number, value: number) => {
  const buf = new DataView(new ArrayBuffer(4))
  buf.setFloat32(0, value, true)
  return [...key(field, 5), ...new Uint8Array(buf.buffer)]
}
const timestamp = (seconds: number) => varintField(1, seconds)

function frame(flags: number, payload: number[]): number[] {
  const n = payload.length
  return [flags, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...payload]
}

const trailer = (text: string) => frame(0x80, [...new TextEncoder().encode(text)])

function creditsMessage(opts: { percent?: number; start?: number; end?: number; extra?: number[] } = {}): number[] {
  const config = [
    ...(opts.percent === undefined ? [] : floatField(1, opts.percent)),
    ...varintField(2, 3),
    ...(opts.start === undefined ? [] : lenField(4, timestamp(opts.start))),
    ...(opts.end === undefined ? [] : lenField(5, timestamp(opts.end))),
    ...(opts.extra ?? []),
  ]
  return [...lenField(1, config), ...varintField(7, 1)]
}

function grpcResponse(body: number[], headers: Record<string, string> = {}, status = 200): Response {
  return new Response(Uint8Array.from(body), {
    status,
    headers: { 'content-type': 'application/grpc-web+proto', ...headers },
  })
}

const OK_BODY = [
  ...frame(0, creditsMessage({ percent: 42.5, start: PERIOD_END - 604800, end: PERIOD_END })),
  ...trailer('grpc-status:0\r\ngrpc-message:\r\n'),
]

function cred(overrides: Partial<GrokCredential> = {}): GrokCredential {
  return {
    scope: SCOPE,
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    expiresAt: '2026-10-23T16:00:00.000Z',
    clientId: 'client-1',
    entry: { auth_mode: 'oidc', email: 'user@example.com' },
    ...overrides,
  }
}

const expiring = () => cred({ expiresAt: '2026-10-23T10:05:00.000Z' })

const tokenOk = () => jsonResponse({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 })

function authHeader(init: RequestInit) {
  return new Headers(init.headers).get('authorization')
}

describe('grokProvider', () => {
  it('is registered as a cloud provider', () => {
    expect(CLOUD_PROVIDERS).toContain(grokProvider)
    expect(grokProvider.source).toBe('cloud')
  })

  it('parses the xAI OIDC scope of a raw GROK_HOME auth.json', () => {
    const parsed = grokProvider.parseCredential(JSON.stringify(fixture('grok/synthetic-auth.json')))
    expect(parsed).toMatchObject({
      scope: SCOPE,
      accessToken: 'grok-access-old',
      refreshToken: 'grok-refresh-old',
      expiresAt: '2026-10-23T16:00:00.000Z',
      clientId: 'client-synthetic',
      issuer: 'https://auth.x.ai',
    })
  })

  it('serializes back to the auth.json shape and round-trips', () => {
    const parsed = grokProvider.parseCredential(JSON.stringify(fixture('grok/synthetic-auth.json')))
    const serialized = grokProvider.serializeCredential({ ...parsed, accessToken: 'rotated' })
    expect(JSON.parse(serialized)).toEqual({
      [SCOPE]: {
        key: 'rotated',
        refresh_token: 'grok-refresh-old',
        expires_at: '2026-10-23T16:00:00.000Z',
        auth_mode: 'oidc',
        email: 'user@example.com',
        team_id: 'team-synthetic',
        oidc_issuer: 'https://auth.x.ai',
        oidc_client_id: 'client-synthetic',
      },
    })
    expect(grokProvider.parseCredential(serialized)).toEqual({ ...parsed, accessToken: 'rotated' })
  })

  it('prefers an active scope, then the newest expiry, then the smaller scope name', () => {
    const entry = (k: string, exp?: string) => ({ key: k, refresh_token: `r-${k}`, ...(exp ? { expires_at: exp } : {}) })
    const raw = (obj: unknown) => JSON.stringify(obj)
    expect(
      grokProvider.parseCredential(
        raw({ 'https://auth.x.ai::b': entry('b', '2026-12-01T00:00:00Z'), 'https://auth.x.ai::a': entry('a', '2026-11-01T00:00:00Z') }),
      ).accessToken,
    ).toBe('b')
    expect(
      grokProvider.parseCredential(
        raw({
          active: 'https://auth.x.ai::a',
          'https://auth.x.ai::b': entry('b', '2026-12-01T00:00:00Z'),
          'https://auth.x.ai::a': entry('a', '2026-11-01T00:00:00Z'),
        }),
      ).accessToken,
    ).toBe('a')
    expect(
      grokProvider.parseCredential(raw({ 'https://auth.x.ai::z': entry('z'), 'https://auth.x.ai::y': entry('y') })).accessToken,
    ).toBe('y')
  })

  it.each([
    ['invalid JSON', 'nope'],
    ['no usable scope', JSON.stringify({ active: 'x', other: { email: 'e' } })],
    ['an array', '[]'],
  ])('rejects a credential with %s', (_n, raw) => {
    expect(() => grokProvider.parseCredential(raw)).toThrow()
  })

  it('reads the weekly credits pool from the first gRPC-web data frame', async () => {
    const fetchFn = mockFetch(() => grpcResponse(OK_BODY, { 'grpc-status': '0' }))
    const result = await grokProvider.read(ctx(cred(), fetchFn))
    expect(result.rotatedCredential).toBeUndefined()
    expect(result.reading).toEqual({
      provider: 'grok',
      ok: true,
      source: 'cloud',
      readAt: NOW.toISOString(),
      quotas: [
        {
          provider: 'grok',
          quotaId: 'weekly',
          name: 'Semanal',
          window: 'weekly',
          remainingFraction: 0.575,
          resetsAt: new Date(PERIOD_END * 1000).toISOString(),
        },
      ],
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe(BILLING_URL)
    expect(init!.method).toBe('POST')
    expect([...new Uint8Array(init!.body as Uint8Array)]).toEqual([0, 0, 0, 0, 0])
    const headers = new Headers(init!.headers)
    expect(headers.get('content-type')).toBe('application/grpc-web+proto')
    expect(headers.get('x-grpc-web')).toBe('1')
    expect(headers.get('origin')).toBe('https://grok.com')
    expect(headers.get('authorization')).toBe('Bearer access-old')
  })

  it('treats an omitted usage percentage as zero usage', async () => {
    const fetchFn = mockFetch(() => grpcResponse(frame(0, creditsMessage({ end: PERIOD_END }))))
    const { reading } = await grokProvider.read(ctx(cred(), fetchFn))
    expect(reading.ok && reading.quotas[0]!.remainingFraction).toBe(1)
  })

  it('accepts an integer usage percentage and clamps it', async () => {
    const fetchFn = mockFetch(() =>
      grpcResponse(frame(0, [...lenField(1, [...varintField(1, 120), ...lenField(5, timestamp(PERIOD_END))])])),
    )
    const { reading } = await grokProvider.read(ctx(cred(), fetchFn))
    expect(reading.ok && reading.quotas[0]!.remainingFraction).toBe(0)
  })

  it('ignores later data frames and unrelated timestamps', async () => {
    const body = [
      ...frame(0, creditsMessage({ percent: 10, end: PERIOD_END, extra: lenField(9, timestamp(PERIOD_END + 999)) })),
      ...frame(0, creditsMessage({ percent: 90, end: PERIOD_END + 5 })),
      ...trailer('grpc-status: 0'),
    ]
    const fetchFn = mockFetch(() => grpcResponse(body))
    const { reading } = await grokProvider.read(ctx(cred(), fetchFn))
    expect(reading.ok && reading.quotas[0]).toMatchObject({
      remainingFraction: 0.9,
      resetsAt: new Date(PERIOD_END * 1000).toISOString(),
    })
  })

  it('refreshes a token expiring within 10 minutes and returns the rotated credential', async () => {
    const fetchFn = mockFetch((url) => (url === TOKEN_URL ? tokenOk() : grpcResponse(OK_BODY)))
    const result = await grokProvider.read(ctx(expiring(), fetchFn))
    expect(result.reading.ok).toBe(true)
    expect(result.rotatedCredential).toEqual({
      ...expiring(),
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      expiresAt: new Date(NOW.getTime() + 3600 * 1000).toISOString(),
    })
    expect(fetchFn.mock.calls.map(([u]) => u)).toEqual([TOKEN_URL, BILLING_URL])
    const [, tokenInit] = fetchFn.mock.calls[0]!
    expect(tokenInit!.method).toBe('POST')
    expect(new Headers(tokenInit!.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(String(tokenInit!.body))
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-old',
      client_id: 'client-1',
    })
    expect(authHeader(fetchFn.mock.calls[1]![1]!)).toBe('Bearer access-new')
  })

  it('uses the credential issuer, keeps the refresh token when not rotated and defaults the lifetime', async () => {
    const fetchFn = mockFetch((url) =>
      url.endsWith('/oauth2/token') ? jsonResponse({ access_token: 'access-new' }) : grpcResponse(OK_BODY),
    )
    const result = await grokProvider.read(ctx(cred({ accessToken: '', issuer: 'https://auth.example.x.ai/' }), fetchFn))
    expect(fetchFn.mock.calls[0]![0]).toBe('https://auth.example.x.ai/oauth2/token')
    expect(result.rotatedCredential).toMatchObject({
      accessToken: 'access-new',
      refreshToken: 'refresh-old',
      expiresAt: new Date(NOW.getTime() + 21600 * 1000).toISOString(),
    })
  })

  it.each([
    [400, { error: 'invalid_grant' }],
    [401, { error: 'invalid_client' }],
    [403, 'forbidden'],
  ])('maps a refresh HTTP %i to auth', async (status, body) => {
    const fetchFn = mockFetch(() => jsonResponse(body, status))
    const result = await grokProvider.read(ctx(expiring(), fetchFn))
    expect(result.reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(result.rotatedCredential).toBeUndefined()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('maps a refresh 5xx to network', async () => {
    const fetchFn = mockFetch(() => jsonResponse('down', 502))
    const result = await grokProvider.read(ctx(expiring(), fetchFn))
    expect(result.reading).toMatchObject({ ok: false, error: { kind: 'network' } })
  })

  it('is auth when the access token is missing and it cannot refresh', async () => {
    const fetchFn = mockFetch(() => grpcResponse(OK_BODY))
    const result = await grokProvider.read(ctx(cred({ accessToken: '', clientId: undefined }), fetchFn))
    expect(result.reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('refreshes once after a billing 401 and retries', async () => {
    let billing = 0
    const fetchFn = mockFetch((url) => {
      if (url === TOKEN_URL) return tokenOk()
      billing += 1
      return billing === 1 ? grpcResponse([], {}, 401) : grpcResponse(OK_BODY)
    })
    const result = await grokProvider.read(ctx(cred(), fetchFn))
    expect(result.reading.ok).toBe(true)
    expect(result.rotatedCredential?.refreshToken).toBe('refresh-new')
    expect(fetchFn.mock.calls.map(([u]) => u)).toEqual([BILLING_URL, TOKEN_URL, BILLING_URL])
    expect(authHeader(fetchFn.mock.calls[2]![1]!)).toBe('Bearer access-new')
  })

  it('refreshes after grpc-status 16 and stops after a second rejection', async () => {
    const fetchFn = mockFetch((url) =>
      url === TOKEN_URL ? tokenOk() : grpcResponse([], { 'grpc-status': '16', 'grpc-message': 'unauthenticated' }),
    )
    const result = await grokProvider.read(ctx(cred(), fetchFn))
    expect(result.reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(result.rotatedCredential?.accessToken).toBe('access-new')
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('still returns the rotated credential when billing fails after a refresh', async () => {
    const fetchFn = mockFetch((url) => (url === TOKEN_URL ? tokenOk() : grpcResponse([], {}, 503)))
    const result = await grokProvider.read(ctx(expiring(), fetchFn))
    expect(result.reading).toMatchObject({ ok: false, error: { kind: 'network' } })
    expect(result.rotatedCredential).toMatchObject({ accessToken: 'access-new', refreshToken: 'refresh-new' })
  })

  it.each([
    ['header 14', grpcResponse(OK_BODY, { 'grpc-status': '14' }), 'network'],
    ['header 7', grpcResponse(OK_BODY, { 'grpc-status': '7' }), 'unavailable'],
    ['trailer 14', grpcResponse([...frame(0, []), ...trailer('grpc-status: 14\r\ngrpc-message: down')]), 'network'],
    ['trailer 5', grpcResponse(trailer('grpc-message:x\r\ngrpc-status:5')), 'unavailable'],
  ])('maps grpc-status in the %s', async (_n, response, kind) => {
    const fetchFn = mockFetch(() => response.clone())
    const { reading } = await grokProvider.read(ctx(cred(), fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind } })
  })

  it('maps grpc-status 16 in the trailers to auth after one refresh', async () => {
    const fetchFn = mockFetch((url) => (url === TOKEN_URL ? tokenOk() : grpcResponse(trailer('grpc-status:16'))))
    const result = await grokProvider.read(ctx(cred(), fetchFn))
    expect(result.reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['an empty body', []],
    ['only trailers', trailer('grpc-status:0')],
    ['a truncated frame', [0, 0, 0, 0, 9, 1, 2]],
    ['malformed protobuf', frame(0, [0x0a, 0x09, 0x01])],
    ['a config without period end', frame(0, creditsMessage({ percent: 5 }))],
  ])('is a parse error for %s', async (_n, body) => {
    const fetchFn = mockFetch(() => grpcResponse(body))
    const { reading } = await grokProvider.read(ctx(cred(), fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
  })

  it('is unavailable when the data frame carries no credits config', async () => {
    const fetchFn = mockFetch(() => grpcResponse([...frame(0, []), ...trailer('grpc-status:0')]))
    const { reading } = await grokProvider.read(ctx(cred(), fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
  })

  it.each([
    [403, 'auth'],
    [500, 'network'],
    [404, 'unavailable'],
  ])('maps billing HTTP %i to %s', async (status, kind) => {
    const fetchFn = mockFetch((url) => (url === TOKEN_URL ? jsonResponse({}, 401) : grpcResponse([], {}, status)))
    const { reading } = await grokProvider.read(ctx(cred(), fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind } })
  })

  it('maps a network failure to network without throwing', async () => {
    const fetchFn = mockFetch(() => {
      throw new TypeError('fetch failed')
    })
    const { reading } = await grokProvider.read(ctx(cred(), fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'network' } })
  })
})
