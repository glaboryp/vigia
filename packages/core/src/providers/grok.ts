import { ProviderError, classifyHttp, errorFromUnknown, fetchBytes, fetchJson } from '../http.js'
import { type ProtoField, decodeFields, decodeMessage } from '../protobuf.js'
import type { ErrorKind, ProviderReading, Quota } from '../types.js'
import { okReading, type Provider, type ProviderContext } from './contract.js'
import { type JsonRecord, clampFraction, isRecord, nonEmptyString, toIso } from './util.js'

export interface GrokCredential {
  scope: string
  accessToken: string
  refreshToken?: string
  expiresAt?: string
  clientId?: string
  issuer?: string
  entry: JsonRecord
}

const BILLING_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig'
const DEFAULT_ISSUER = 'https://auth.x.ai'
const REFRESH_MARGIN_MS = 10 * 60 * 1000
const DEFAULT_TOKEN_TTL_S = 21_600
const KNOWN_FIELDS = new Set(['key', 'refresh_token', 'expires_at', 'oidc_client_id', 'oidc_issuer'])
const ACTIVE_KEYS = ['active', 'active_account', 'active_scope', 'current']
const MAX_TIMESTAMP_S = 253402300799n

class UnauthenticatedError extends ProviderError {}

function expiryMs(value: unknown): number | undefined {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()))) {
    const iso = toIso(value)
    return iso ? Date.parse(iso) : undefined
  }
  const text = nonEmptyString(value)
  if (!text) return undefined
  const ms = Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(text) ? text : `${text.replace(' ', 'T')}Z`)
  return Number.isFinite(ms) ? ms : undefined
}

function parseCredential(raw: string): GrokCredential {
  const root: unknown = JSON.parse(raw)
  if (!isRecord(root)) throw new Error('Grok auth.json must be a JSON object')
  const usable = Object.entries(root).flatMap(([scope, entry]) =>
    isRecord(entry) && (nonEmptyString(entry.key) || nonEmptyString(entry.refresh_token)) ? [{ scope, entry }] : [],
  )
  if (usable.length === 0) throw new Error('Grok auth.json has no usable credential')
  const named = ACTIVE_KEYS.map((k) => nonEmptyString(root[k])).filter((s): s is string => s !== undefined)
  const active = usable.filter((u) => u.entry.active === true || named.includes(u.scope))
  const xai = usable.filter((u) => u.scope.startsWith('https://auth.x.ai::'))
  const pool = active.length > 0 ? active : xai.length > 0 ? xai : usable
  const rank = (u: (typeof usable)[number]) => expiryMs(u.entry.expires_at) ?? -Infinity
  const best = pool.reduce((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    return rb > ra || (rb === ra && b.scope < a.scope) ? b : a
  })
  const entry = best.entry
  const cred: GrokCredential = {
    scope: best.scope,
    accessToken: nonEmptyString(entry.key) ?? '',
    entry: Object.fromEntries(Object.entries(entry).filter(([k]) => !KNOWN_FIELDS.has(k))),
  }
  const refreshToken = nonEmptyString(entry.refresh_token)
  const expiresMs = expiryMs(entry.expires_at)
  const expiresAt = expiresMs === undefined ? undefined : new Date(expiresMs).toISOString()
  const clientId = nonEmptyString(entry.oidc_client_id)
  const issuer = nonEmptyString(entry.oidc_issuer)
  if (refreshToken) cred.refreshToken = refreshToken
  if (expiresAt) cred.expiresAt = expiresAt
  if (clientId) cred.clientId = clientId
  if (issuer) cred.issuer = issuer
  return cred
}

function serializeCredential(c: GrokCredential): string {
  const entry: JsonRecord = { ...c.entry, key: c.accessToken }
  if (c.refreshToken) entry.refresh_token = c.refreshToken
  if (c.expiresAt) entry.expires_at = c.expiresAt
  if (c.issuer) entry.oidc_issuer = c.issuer
  if (c.clientId) entry.oidc_client_id = c.clientId
  return JSON.stringify({ [c.scope]: entry })
}

const canRefresh = (c: GrokCredential) => Boolean(c.refreshToken && c.clientId)

function needsRefresh(c: GrokCredential, now: Date): boolean {
  if (!canRefresh(c)) return false
  if (c.accessToken === '') return true
  const exp = expiryMs(c.expiresAt)
  return exp !== undefined && exp < now.getTime() + REFRESH_MARGIN_MS
}

function tokenUrl(issuer: string | undefined): string {
  const base = issuer?.startsWith('https://') ? issuer.replace(/\/+$/, '') : DEFAULT_ISSUER
  return `${base}/oauth2/token`
}

async function refresh(ctx: ProviderContext<GrokCredential>, cred: GrokCredential): Promise<GrokCredential> {
  if (!cred.refreshToken || !cred.clientId) {
    throw new ProviderError('auth', 'Sesión de Grok caducada; vuelve a iniciar sesión')
  }
  const { status, body } = await fetchJson(ctx, tokenUrl(cred.issuer), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cred.refreshToken,
      client_id: cred.clientId,
    }).toString(),
  })
  if (status < 200 || status >= 300) {
    if (classifyHttp(status) === 'network') throw new ProviderError('network', `Grok token refresh HTTP ${status}`)
    throw new ProviderError('auth', `Sesión de Grok caducada (HTTP ${status}); vuelve a iniciar sesión`)
  }
  if (!isRecord(body)) throw new ProviderError('parse', 'Unexpected Grok token refresh response')
  const accessToken = nonEmptyString(body.access_token) ?? cred.accessToken
  const ttl = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : DEFAULT_TOKEN_TTL_S
  return {
    ...cred,
    accessToken,
    refreshToken: nonEmptyString(body.refresh_token) ?? cred.refreshToken,
    expiresAt: new Date(ctx.now().getTime() + ttl * 1000).toISOString(),
  }
}

function checkGrpcStatus(code: string | null | undefined, message: string | null | undefined): void {
  if (code === null || code === undefined || code.trim() === '') return
  const status = Number(code.trim())
  if (status === 0) return
  const text = `Grok gRPC status ${code.trim()}${message ? `: ${message}` : ''}`
  if (status === 16) throw new UnauthenticatedError('auth', text)
  const kind: ErrorKind = status === 14 ? 'network' : 'unavailable'
  throw new ProviderError(kind, text)
}

function checkTrailer(block: Uint8Array): void {
  const values = new Map<string, string>()
  for (const line of new TextDecoder().decode(block).split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx > 0) values.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim())
  }
  checkGrpcStatus(values.get('grpc-status'), values.get('grpc-message'))
}

function splitFrames(body: Uint8Array): { data?: Uint8Array; trailers: Uint8Array[] } {
  const trailers: Uint8Array[] = []
  let data: Uint8Array | undefined
  let pos = 0
  while (pos < body.length) {
    if (pos + 5 > body.length) throw new ProviderError('parse', 'Truncated Grok gRPC-web frame')
    const flags = body[pos]!
    const length = ((body[pos + 1]! << 24) | (body[pos + 2]! << 16) | (body[pos + 3]! << 8) | body[pos + 4]!) >>> 0
    const start = pos + 5
    if (start + length > body.length) throw new ProviderError('parse', 'Truncated Grok gRPC-web frame')
    const payload = body.subarray(start, start + length)
    if (flags & 0x80) trailers.push(payload)
    else if (!data) {
      if (flags & 0x01) throw new ProviderError('parse', 'Respuesta gRPC comprimida no soportada')
      data = payload
    }
    pos = start + length
  }
  return { data, trailers }
}

function decode(bytes: Uint8Array): ProtoField[] {
  try {
    return decodeFields(bytes)
  } catch (err) {
    throw new ProviderError('parse', `Malformed Grok protobuf: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function usedPercent(field: ProtoField | undefined): number {
  if (!field) return 0
  const { wire, value } = field
  let n: number | undefined
  if (wire === 0 && typeof value === 'bigint') n = Number(value)
  else if (value instanceof Uint8Array) {
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength)
    if (wire === 5) n = view.getFloat32(0, true)
    else if (wire === 1) n = view.getFloat64(0, true)
  }
  if (n === undefined || !Number.isFinite(n)) throw new ProviderError('parse', 'Grok usage percentage is not a number')
  return n
}

function parseCredits(data: Uint8Array): Quota {
  const config = decode(data).find((f) => f.field === 1 && f.wire === 2)?.value
  if (!(config instanceof Uint8Array)) throw new ProviderError('unavailable', 'Sin créditos semanales de Grok')
  const fields = decode(config)
  const percent = usedPercent(fields.find((f) => f.field === 1))
  const periodEnd = fields.find((f) => f.field === 5 && f.wire === 2)?.value
  let seconds: bigint | Uint8Array | undefined
  if (periodEnd instanceof Uint8Array) {
    try {
      seconds = decodeMessage(periodEnd).get(1)?.[0]
    } catch {
      seconds = undefined
    }
  }
  if (typeof seconds !== 'bigint') throw new ProviderError('parse', 'Grok credits config has no period end')
  if (seconds <= 0n || seconds > MAX_TIMESTAMP_S) throw new ProviderError('parse', 'Grok period end is out of range')
  return {
    provider: 'grok',
    quotaId: 'weekly',
    name: 'Semanal',
    window: 'weekly',
    remainingFraction: clampFraction((100 - percent) / 100),
    resetsAt: new Date(Number(seconds) * 1000).toISOString(),
  }
}

async function readBilling(ctx: ProviderContext<GrokCredential>, cred: GrokCredential): Promise<Quota[]> {
  const { status, headers, body } = await fetchBytes(ctx, BILLING_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cred.accessToken}`,
      'Content-Type': 'application/grpc-web+proto',
      'x-grpc-web': '1',
      'x-user-agent': 'connect-es/2.1.1',
      Origin: 'https://grok.com',
      Referer: 'https://grok.com/?_s=usage',
      Accept: '*/*',
    },
    body: new Uint8Array(5),
  })
  if (status === 401) throw new UnauthenticatedError('auth', 'Grok HTTP 401')
  const kind = classifyHttp(status)
  if (kind) throw new ProviderError(kind, `Grok HTTP ${status}`)
  checkGrpcStatus(headers.get('grpc-status'), headers.get('grpc-message'))
  const { data, trailers } = splitFrames(body)
  trailers.forEach(checkTrailer)
  if (!data) throw new ProviderError('parse', 'Grok billing returned no data frame')
  return [parseCredits(data)]
}

export const grokProvider: Provider<GrokCredential> = {
  id: 'grok',
  source: 'cloud',
  parseCredential,
  serializeCredential,
  async read(ctx) {
    const now = ctx.now()
    let cred = ctx.credential
    let rotated: GrokCredential | undefined
    const result = (reading: ProviderReading) => (rotated ? { reading, rotatedCredential: rotated } : { reading })
    try {
      if (cred.accessToken === '' && !canRefresh(cred)) {
        throw new ProviderError('auth', 'Sesión de Grok caducada; vuelve a iniciar sesión')
      }
      if (needsRefresh(cred, now)) cred = rotated = await refresh(ctx, cred)
      let quotas: Quota[]
      try {
        quotas = await readBilling(ctx, cred)
      } catch (err) {
        if (!(err instanceof UnauthenticatedError) || rotated || !canRefresh(cred)) throw err
        cred = rotated = await refresh(ctx, cred)
        quotas = await readBilling(ctx, cred)
      }
      return result(okReading('grok', 'cloud', quotas, now))
    } catch (err) {
      return result(errorFromUnknown('grok', 'cloud', err, now))
    }
  },
}
