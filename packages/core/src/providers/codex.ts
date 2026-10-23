import { ProviderError, classifyHttp, errorFromUnknown, fetchJson } from '../http.js'
import type { ProviderReading, Quota } from '../types.js'
import { okReading, type Provider, type ProviderContext } from './contract.js'
import {
  type JsonRecord,
  clampFraction,
  decodeJwtPayload,
  isRecord,
  nonEmptyString,
  pick,
  pickNumber,
  toIso,
} from './util.js'

export interface CodexCredential {
  accessToken: string
  refreshToken: string
  idToken?: string
  accountId?: string
  lastRefresh?: string
}

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const REFRESH_MARGIN_MS = 60 * 60 * 1000
const WEEKLY_MIN_SECONDS = 3 * 24 * 3600
const AUTH_REFRESH_CODES = new Set([
  'refresh_token_reused',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'invalid_grant',
])

function accountIdFromJwt(token: string | undefined): string | undefined {
  const claims = decodeJwtPayload(token)?.['https://api.openai.com/auth']
  return isRecord(claims) ? nonEmptyString(claims.chatgpt_account_id) : undefined
}

function parseCredential(raw: string): CodexCredential {
  const root: unknown = JSON.parse(raw)
  if (!isRecord(root)) throw new Error('Codex credential must be a JSON object')
  const src: JsonRecord = isRecord(root.tokens) ? root.tokens : root
  const accessToken = nonEmptyString(pick(src, 'access_token', 'accessToken')) ?? ''
  const refreshToken = nonEmptyString(pick(src, 'refresh_token', 'refreshToken'))
  if (!refreshToken) throw new Error('Codex credential has no refresh token')
  const idToken = nonEmptyString(pick(src, 'id_token', 'idToken'))
  const accountId =
    nonEmptyString(pick(src, 'account_id', 'accountId')) ?? accountIdFromJwt(idToken) ?? accountIdFromJwt(accessToken)
  const lastRefresh = nonEmptyString(pick(root, 'last_refresh', 'lastRefresh'))
  const cred: CodexCredential = { accessToken, refreshToken }
  if (idToken) cred.idToken = idToken
  if (accountId) cred.accountId = accountId
  if (lastRefresh) cred.lastRefresh = lastRefresh
  return cred
}

function needsRefresh(cred: CodexCredential, now: Date): boolean {
  if (cred.accessToken === '') return true
  const exp = decodeJwtPayload(cred.accessToken)?.exp
  return typeof exp === 'number' && exp * 1000 < now.getTime() + REFRESH_MARGIN_MS
}

function refreshErrorCode(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const error = body.error
  const code = typeof error === 'string' ? error : isRecord(error) ? error.code : body.code
  return typeof code === 'string' ? code.toLowerCase() : undefined
}

async function refresh(ctx: ProviderContext<CodexCredential>, cred: CodexCredential): Promise<CodexCredential> {
  const { status, body } = await fetchJson(ctx, TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: cred.refreshToken }),
  })
  if (status < 200 || status >= 300) {
    const code = refreshErrorCode(body)
    if ((code && AUTH_REFRESH_CODES.has(code)) || status === 401) {
      throw new ProviderError('auth', `Sesión de Codex caducada (${code ?? `HTTP ${status}`}); vuelve a iniciar sesión`)
    }
    throw new ProviderError('network', `Codex token refresh HTTP ${status}`)
  }
  if (!isRecord(body)) throw new ProviderError('parse', 'Unexpected Codex token refresh response')
  const accessToken = nonEmptyString(body.access_token) ?? cred.accessToken
  const idToken = nonEmptyString(body.id_token) ?? cred.idToken
  const next: CodexCredential = {
    accessToken,
    refreshToken: nonEmptyString(body.refresh_token) ?? cred.refreshToken,
    lastRefresh: ctx.now().toISOString(),
  }
  if (idToken) next.idToken = idToken
  const accountId = cred.accountId ?? accountIdFromJwt(idToken) ?? accountIdFromJwt(accessToken)
  if (accountId) next.accountId = accountId
  return next
}

function fetchUsage(ctx: ProviderContext<CodexCredential>, cred: CodexCredential) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cred.accessToken}`,
    Accept: 'application/json',
    'User-Agent': 'codex-cli',
  }
  if (cred.accountId) headers['ChatGPT-Account-Id'] = cred.accountId
  return fetchJson(ctx, USAGE_URL, { method: 'GET', headers })
}

function isPlaceholder(window: JsonRecord): boolean {
  return ['used_percent', 'usage_percent', 'limit_window_seconds', 'reset_at', 'reset_after_seconds'].every(
    (key) => window[key] === undefined || window[key] === null,
  )
}

function parseWindow(window: JsonRecord, fallback: '5h' | 'weekly', now: Date): Quota {
  const used = pickNumber(window, 'used_percent', 'usage_percent')
  if (used === undefined) throw new ProviderError('parse', 'Codex window has no used_percent')
  const seconds = pickNumber(window, 'limit_window_seconds')
  const kind = seconds === undefined ? fallback : seconds >= WEEKLY_MIN_SECONDS ? 'weekly' : '5h'
  let resetsAt = toIso(pick(window, 'reset_at'))
  const after = pickNumber(window, 'reset_after_seconds')
  if (!resetsAt && after !== undefined) resetsAt = new Date(now.getTime() + after * 1000).toISOString()
  if (!resetsAt) throw new ProviderError('parse', 'Codex window has no reset time')
  return {
    provider: 'codex',
    quotaId: kind,
    name: kind === 'weekly' ? 'Semanal' : '5 horas',
    window: kind,
    remainingFraction: clampFraction((100 - used) / 100),
    resetsAt,
  }
}

function parseQuotas(body: unknown, now: Date): Quota[] {
  if (!isRecord(body) || !('rate_limit' in body)) throw new ProviderError('parse', 'Unexpected Codex usage response')
  const rateLimit = body.rate_limit
  if (rateLimit === null) throw new ProviderError('unavailable', 'Sin límites de uso de Codex')
  if (!isRecord(rateLimit)) throw new ProviderError('parse', 'Unexpected Codex rate_limit')
  const quotas = new Map<string, Quota>()
  for (const [key, fallback] of [
    ['secondary_window', 'weekly'],
    ['primary_window', '5h'],
  ] as const) {
    const window = rateLimit[key]
    if (!isRecord(window) || isPlaceholder(window)) continue
    const quota = parseWindow(window, fallback, now)
    if (!quotas.has(quota.quotaId)) quotas.set(quota.quotaId, quota)
  }
  if (quotas.size === 0) throw new ProviderError('unavailable', 'Sin límites de uso de Codex')
  return ['weekly', '5h'].flatMap((id) => quotas.get(id) ?? [])
}

export const codexProvider: Provider<CodexCredential> = {
  id: 'codex',
  source: 'cloud',
  parseCredential,
  serializeCredential: (c) => JSON.stringify(c),
  async read(ctx) {
    const now = ctx.now()
    let cred = ctx.credential
    let rotated: CodexCredential | undefined
    const result = (reading: ProviderReading) => (rotated ? { reading, rotatedCredential: rotated } : { reading })
    try {
      if (needsRefresh(cred, now)) cred = rotated = await refresh(ctx, cred)
      let response = await fetchUsage(ctx, cred)
      if (response.status === 401 && !rotated) {
        cred = rotated = await refresh(ctx, cred)
        response = await fetchUsage(ctx, cred)
      }
      const kind = classifyHttp(response.status)
      if (kind) throw new ProviderError(kind, `Codex HTTP ${response.status}`)
      return result(okReading('codex', 'cloud', parseQuotas(response.body, now), now))
    } catch (err) {
      return result(errorFromUnknown('codex', 'cloud', err, now))
    }
  },
}
