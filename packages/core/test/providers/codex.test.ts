import { describe, expect, it } from 'vitest'
import { codexProvider, type CodexCredential } from '../../src/providers/codex.js'
import { CLOUD_PROVIDERS } from '../../src/providers/registry.js'
import { NOW, ctx, fixture, jsonResponse, mockFetch } from './helpers.js'

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const NOW_S = Math.floor(NOW.getTime() / 1000)

function b64url(text: string): string {
  return Buffer.from(text).toString('base64url')
}

function jwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify(payload))}.sig`
}

function cred(overrides: Partial<CodexCredential> = {}): CodexCredential {
  return {
    accessToken: jwt({ exp: NOW_S + 2 * 3600 }),
    refreshToken: 'rt-old',
    idToken: 'id-old',
    accountId: 'acct-1',
    lastRefresh: '2026-10-20T08:00:00.000Z',
    ...overrides,
  }
}

const NEW_ACCESS = jwt({ exp: NOW_S + 10 * 86400 })

function tokenResponse(extra: Record<string, unknown> = {}) {
  return jsonResponse({ access_token: NEW_ACCESS, refresh_token: 'rt-new', id_token: 'id-new', ...extra })
}

function auth(init: RequestInit) {
  return new Headers(init.headers).get('authorization')
}

describe('codexProvider', () => {
  it('is registered as a cloud provider', () => {
    expect(CLOUD_PROVIDERS).toContain(codexProvider)
    expect(codexProvider.source).toBe('cloud')
  })

  it('parses a raw CODEX_HOME auth.json and serializes it flattened', () => {
    const parsed = codexProvider.parseCredential(JSON.stringify(fixture('codex/synthetic-auth.json')))
    expect(parsed).toEqual({
      accessToken: 'synthetic.access.token',
      refreshToken: 'rt_synthetic_old',
      idToken: 'synthetic.id.token',
      accountId: 'acct-synthetic-123',
      lastRefresh: '2026-10-20T08:00:00.000Z',
    })
    const serialized = codexProvider.serializeCredential(parsed)
    expect(JSON.parse(serialized)).toEqual(parsed)
    expect(codexProvider.parseCredential(serialized)).toEqual(parsed)
  })

  it('falls back to the chatgpt_account_id claim of the id token', () => {
    const idToken = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-from-jwt' } })
    const raw = JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r', id_token: idToken } })
    expect(codexProvider.parseCredential(raw).accountId).toBe('acct-from-jwt')
  })

  it.each([
    ['invalid JSON', 'not json'],
    ['no refresh token', JSON.stringify({ tokens: { access_token: 'a' } })],
    ['empty object', '{}'],
  ])('rejects a credential with %s', (_n, raw) => {
    expect(() => codexProvider.parseCredential(raw)).toThrow()
  })

  it('reads weekly and 5h windows with a fresh token and does not refresh', async () => {
    const fetchFn = mockFetch(() => jsonResponse(fixture('codex/synthetic-usage.json')))
    const result = await codexProvider.read(ctx(cred(), fetchFn))
    expect(result.rotatedCredential).toBeUndefined()
    expect(result.reading).toEqual({
      provider: 'codex',
      ok: true,
      source: 'cloud',
      readAt: NOW.toISOString(),
      quotas: [
        {
          provider: 'codex',
          quotaId: 'weekly',
          name: 'Semanal',
          window: 'weekly',
          remainingFraction: 0.58,
          resetsAt: new Date(1793100000 * 1000).toISOString(),
        },
        {
          provider: 'codex',
          quotaId: '5h',
          name: '5 horas',
          window: '5h',
          remainingFraction: 0.82,
          resetsAt: new Date(1792758600 * 1000).toISOString(),
        },
      ],
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe(USAGE_URL)
    expect(init!.method ?? 'GET').toBe('GET')
    const headers = new Headers(init!.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${cred().accessToken}`)
    expect(headers.get('chatgpt-account-id')).toBe('acct-1')
  })

  it('classifies windows by length and derives the reset from reset_after_seconds', async () => {
    const fetchFn = mockFetch(() => jsonResponse(fixture('codex/synthetic-weekly-in-primary.json')))
    const { reading } = await codexProvider.read(ctx(cred(), fetchFn))
    expect(reading.ok && reading.quotas).toEqual([
      {
        provider: 'codex',
        quotaId: 'weekly',
        name: 'Semanal',
        window: 'weekly',
        remainingFraction: 0,
        resetsAt: new Date(NOW.getTime() + 296921 * 1000).toISOString(),
      },
    ])
  })

  it('omits the account header when no account id is known', async () => {
    const fetchFn = mockFetch(() => jsonResponse(fixture('codex/synthetic-usage.json')))
    await codexProvider.read(ctx(cred({ accountId: undefined }), fetchFn))
    expect(new Headers(fetchFn.mock.calls[0]![1]!.headers).has('chatgpt-account-id')).toBe(false)
  })

  it('refreshes a token expiring within an hour and returns the rotated credential', async () => {
    const fetchFn = mockFetch((url) =>
      url === TOKEN_URL ? tokenResponse() : jsonResponse(fixture('codex/synthetic-usage.json')),
    )
    const result = await codexProvider.read(ctx(cred({ accessToken: jwt({ exp: NOW_S + 1800 }) }), fetchFn))
    expect(result.reading.ok).toBe(true)
    expect(result.rotatedCredential).toEqual({
      accessToken: NEW_ACCESS,
      refreshToken: 'rt-new',
      idToken: 'id-new',
      accountId: 'acct-1',
      lastRefresh: NOW.toISOString(),
    })
    expect(fetchFn.mock.calls.map(([u]) => u)).toEqual([TOKEN_URL, USAGE_URL])
    const [, tokenInit] = fetchFn.mock.calls[0]!
    expect(tokenInit!.method).toBe('POST')
    expect(new Headers(tokenInit!.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(tokenInit!.body))).toEqual({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      grant_type: 'refresh_token',
      refresh_token: 'rt-old',
    })
    expect(auth(fetchFn.mock.calls[1]![1]!)).toBe(`Bearer ${NEW_ACCESS}`)
  })

  it('keeps the previous refresh and id tokens when the refresh response omits them', async () => {
    const fetchFn = mockFetch((url) =>
      url === TOKEN_URL
        ? jsonResponse({ access_token: NEW_ACCESS })
        : jsonResponse(fixture('codex/synthetic-usage.json')),
    )
    const { rotatedCredential } = await codexProvider.read(ctx(cred({ accessToken: '' }), fetchFn))
    expect(rotatedCredential).toMatchObject({ accessToken: NEW_ACCESS, refreshToken: 'rt-old', idToken: 'id-old' })
  })

  it('derives the account id from a refreshed id token when none was stored', async () => {
    const idToken = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-new' } })
    const fetchFn = mockFetch((url) =>
      url === TOKEN_URL ? tokenResponse({ id_token: idToken }) : jsonResponse(fixture('codex/synthetic-usage.json')),
    )
    const expired = cred({ accessToken: jwt({ exp: NOW_S - 60 }), accountId: undefined })
    const { rotatedCredential } = await codexProvider.read(ctx(expired, fetchFn))
    expect(rotatedCredential?.accountId).toBe('acct-new')
    expect(new Headers(fetchFn.mock.calls[1]![1]!.headers).get('chatgpt-account-id')).toBe('acct-new')
  })

  it.each([
    ['refresh_token_reused', 401, { error: { code: 'refresh_token_reused', message: 'reused' } }],
    ['refresh_token_expired', 401, { code: 'refresh_token_expired' }],
    ['refresh_token_invalidated', 401, { error: 'refresh_token_invalidated' }],
    ['invalid_grant', 400, { error: 'invalid_grant', error_description: 'bad' }],
    ['a bare 401', 401, 'nope'],
  ])('maps a refresh failure with %s to auth', async (_n, status, body) => {
    const fetchFn = mockFetch(() => jsonResponse(body, status))
    const result = await codexProvider.read(ctx(cred({ accessToken: jwt({ exp: NOW_S - 1 }) }), fetchFn))
    expect(result.reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(result.rotatedCredential).toBeUndefined()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a 5xx', 503, 'down'],
    ['a bare 400 without a known code', 400, {}],
    ['a 400 with an unknown code', 400, { error: 'temporarily_unavailable' }],
  ])('maps a refresh failure with %s to network', async (_n, status, body) => {
    const fetchFn = mockFetch(() => jsonResponse(body, status))
    const result = await codexProvider.read(ctx(cred({ accessToken: '' }), fetchFn))
    expect(result.reading).toMatchObject({ ok: false, error: { kind: 'network' } })
    expect(result.rotatedCredential).toBeUndefined()
  })

  it('keeps the old access token and stores the rotated refresh token when the refresh omits access_token', async () => {
    const oldAccess = jwt({ exp: NOW_S + 60 })
    const fetchFn = mockFetch((url) =>
      url === TOKEN_URL
        ? jsonResponse({ refresh_token: 'rt-new', id_token: 'id-new' })
        : jsonResponse(fixture('codex/synthetic-usage.json')),
    )
    const result = await codexProvider.read(ctx(cred({ accessToken: oldAccess }), fetchFn))
    expect(result.reading.ok).toBe(true)
    expect(result.rotatedCredential).toEqual({
      accessToken: oldAccess,
      refreshToken: 'rt-new',
      idToken: 'id-new',
      accountId: 'acct-1',
      lastRefresh: NOW.toISOString(),
    })
    expect(auth(fetchFn.mock.calls[1]![1]!)).toBe(`Bearer ${oldAccess}`)
  })

  it('returns auth with the rotated refresh token when the kept access token is rejected', async () => {
    const fetchFn = mockFetch((url) => (url === TOKEN_URL ? jsonResponse({ refresh_token: 'rt-new' }) : jsonResponse({}, 401)))
    const result = await codexProvider.read(ctx(cred({ accessToken: jwt({ exp: NOW_S - 1 }) }), fetchFn))
    expect(result.reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(result.rotatedCredential?.refreshToken).toBe('rt-new')
    expect(fetchFn.mock.calls.map(([u]) => u)).toEqual([TOKEN_URL, USAGE_URL])
  })

  it('is a parse error when the refresh response is not a JSON object', async () => {
    const fetchFn = mockFetch(() => jsonResponse([1, 2]))
    const result = await codexProvider.read(ctx(cred({ accessToken: '' }), fetchFn))
    expect(result.reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
    expect(result.rotatedCredential).toBeUndefined()
  })

  it('refreshes once after a usage 401 and retries the usage call', async () => {
    let usageCalls = 0
    const fetchFn = mockFetch((url) => {
      if (url === TOKEN_URL) return tokenResponse()
      usageCalls += 1
      return usageCalls === 1 ? jsonResponse({ detail: 'expired' }, 401) : jsonResponse(fixture('codex/synthetic-usage.json'))
    })
    const result = await codexProvider.read(ctx(cred(), fetchFn))
    expect(result.reading.ok).toBe(true)
    expect(result.rotatedCredential?.refreshToken).toBe('rt-new')
    expect(fetchFn.mock.calls.map(([u]) => u)).toEqual([USAGE_URL, TOKEN_URL, USAGE_URL])
    expect(auth(fetchFn.mock.calls[2]![1]!)).toBe(`Bearer ${NEW_ACCESS}`)
  })

  it('does not refresh twice when usage still answers 401 after a refresh', async () => {
    const fetchFn = mockFetch((url) => (url === TOKEN_URL ? tokenResponse() : jsonResponse({}, 401)))
    const result = await codexProvider.read(ctx(cred(), fetchFn))
    expect(result.reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(result.rotatedCredential?.refreshToken).toBe('rt-new')
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('still returns the rotated credential when usage fails after a successful refresh', async () => {
    const fetchFn = mockFetch((url) => (url === TOKEN_URL ? tokenResponse() : jsonResponse('boom', 500)))
    const result = await codexProvider.read(ctx(cred({ accessToken: jwt({ exp: NOW_S + 60 }) }), fetchFn))
    expect(result.reading).toMatchObject({ ok: false, error: { kind: 'network' } })
    expect(result.rotatedCredential).toMatchObject({ accessToken: NEW_ACCESS, refreshToken: 'rt-new' })
  })

  it('still returns the rotated credential when the usage body cannot be parsed', async () => {
    const fetchFn = mockFetch((url) => (url === TOKEN_URL ? tokenResponse() : jsonResponse({ nope: true })))
    const result = await codexProvider.read(ctx(cred({ accessToken: '' }), fetchFn))
    expect(result.reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
    expect(result.rotatedCredential?.refreshToken).toBe('rt-new')
  })

  it('maps a usage 403 to auth without refreshing', async () => {
    const fetchFn = mockFetch(() => jsonResponse({}, 403))
    const result = await codexProvider.read(ctx(cred(), fetchFn))
    expect(result.reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('is unavailable when the account has no rate limits', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ plan_type: 'free', rate_limit: null }))
    const { reading } = await codexProvider.read(ctx(cred(), fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
  })

  it('is unavailable when both windows are empty placeholders', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ rate_limit: { primary_window: {}, secondary_window: null } }))
    const { reading } = await codexProvider.read(ctx(cred(), fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
  })

  it.each([
    ['unexpected envelope', { nope: true }],
    ['window without percentage', { rate_limit: { secondary_window: { limit_window_seconds: 604800, reset_at: 1 } } }],
    ['window without reset', { rate_limit: { secondary_window: { used_percent: 3, limit_window_seconds: 604800 } } }],
  ])('is a parse error for %s', async (_n, body) => {
    const fetchFn = mockFetch(() => jsonResponse(body))
    const { reading } = await codexProvider.read(ctx(cred(), fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
  })

  it('maps a network failure to network without throwing', async () => {
    const fetchFn = mockFetch(() => {
      throw new TypeError('fetch failed')
    })
    const { reading } = await codexProvider.read(ctx(cred(), fetchFn))
    expect(reading).toMatchObject({ ok: false, error: { kind: 'network' } })
  })
})
