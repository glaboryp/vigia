import { ProviderError, classifyHttp, errorFromUnknown, fetchJson } from '../http.js'
import type { Quota } from '../types.js'
import { okReading, type Provider } from './contract.js'
import { clampFraction, isRecord, pick, pickNumber, toIso, type JsonRecord } from './util.js'

const BASE = 'https://openapi.qoder.sh'
const EXCHANGE_URL = `${BASE}/api/v1/jobToken/exchange`
const STATUS_URL = `${BASE}/api/v3/user/status`
const USAGE_URL = `${BASE}/api/v2/quota/usage`

export interface QoderCredential {
  pat: string
}

interface Parsed {
  used?: number
  total?: number
  remaining?: number
  resetsAt?: string
}

function root(body: unknown): JsonRecord {
  if (!isRecord(body)) throw new ProviderError('parse', 'Unexpected Qoder response')
  return isRecord(body.data) ? body.data : body
}

function summary(container: unknown): { used: number; total: number; remaining: number } | undefined {
  if (!isRecord(container)) return undefined
  const s = pick(container, 'quotaSummary', 'quota_summary')
  if (!isRecord(s)) return undefined
  const used = pickNumber(s, 'usedValue', 'used_value')
  const total = pickNumber(s, 'limitValue', 'limit_value')
  if (used === undefined || total === undefined) return undefined
  const remaining = pickNumber(s, 'remainingValue', 'remaining_value') ?? Math.max(0, total - used)
  return { used, total, remaining }
}

function parseStatus(body: unknown): Parsed {
  const r = root(body)
  const resetsAt = toIso(pick(r, 'nextResetAt', 'next_reset_at', 'expiresAt', 'expires_at'))
  const base = summary(pick(r, 'totalQuota', 'total_quota'))
  if (base) {
    const shared = summary(pick(r, 'sharedQuota', 'shared_quota'))
    const used = base.used + (shared?.used ?? 0)
    const total = base.total + (shared?.total ?? 0)
    const remaining = base.remaining + (shared?.remaining ?? 0)
    return { used, total, remaining, resetsAt }
  }
  const total = pickNumber(r, 'totalCredits', 'total_credits', 'total', 'limit')
  const used = pickNumber(r, 'usedCredits', 'used_credits', 'used')
  if (total === undefined || used === undefined) return { resetsAt }
  return { used, total, remaining: Math.max(0, total - used), resetsAt }
}

async function authed(ctx: { fetch: typeof fetch }, url: string, jobToken: string) {
  return fetchJson(ctx, url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${jobToken}`, Accept: 'application/json' },
  })
}

async function exchange(ctx: { fetch: typeof fetch }, pat: string): Promise<string> {
  const { status, body } = await fetchJson(ctx, EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ personal_token: pat }),
  })
  const kind = classifyHttp(status)
  if (kind) throw new ProviderError(kind, `Qoder token exchange HTTP ${status}`)
  const r = isRecord(body) ? root(body) : {}
  const token = pick(r, 'jobToken', 'job_token', 'token', 'accessToken')
  if (typeof token !== 'string' || token === '') throw new ProviderError('parse', 'Qoder exchange returned no job token')
  return token
}

async function readQuotas(ctx: { fetch: typeof fetch }, pat: string): Promise<Quota[]> {
  const jobToken = await exchange(ctx, pat)

  const v3 = await authed(ctx, STATUS_URL, jobToken)
  const v3Kind = classifyHttp(v3.status)
  if (v3Kind === 'auth' || v3Kind === 'network') throw new ProviderError(v3Kind, `Qoder status HTTP ${v3.status}`)
  let parsed: Parsed = v3Kind ? {} : parseStatus(v3.body)

  if (parsed.total === undefined || parsed.resetsAt === undefined) {
    const v2 = await authed(ctx, USAGE_URL, jobToken)
    const v2Kind = classifyHttp(v2.status)
    if (v2Kind === 'auth' || v2Kind === 'network') throw new ProviderError(v2Kind, `Qoder usage HTTP ${v2.status}`)
    if (!v2Kind) {
      const fallback = parseStatus(v2.body)
      parsed = { ...(parsed.total !== undefined ? parsed : fallback), resetsAt: parsed.resetsAt ?? fallback.resetsAt }
    }
  }

  if (parsed.total === undefined || parsed.used === undefined || parsed.remaining === undefined) {
    throw new ProviderError('unavailable', 'Qoder no devolvió cuota')
  }
  if (parsed.resetsAt === undefined) throw new ProviderError('parse', 'Qoder quota has no reset date')

  return [
    {
      provider: 'qoder',
      quotaId: 'plan',
      name: 'Qoder',
      window: 'monthly',
      remainingFraction: parsed.total > 0 ? clampFraction(parsed.remaining / parsed.total) : 0,
      remaining: parsed.remaining,
      total: parsed.total,
      unit: 'créditos',
      resetsAt: parsed.resetsAt,
    },
  ]
}

export const qoderProvider: Provider<QoderCredential> = {
  id: 'qoder',
  source: 'cloud',
  parseCredential(raw) {
    const text = raw.trim()
    if (text === '') throw new Error('Empty Qoder credential')
    if (text.startsWith('{')) {
      const parsed: unknown = JSON.parse(text)
      if (!isRecord(parsed) || typeof parsed.pat !== 'string' || parsed.pat.trim() === '') {
        throw new Error('Qoder credential must contain a pat')
      }
      return { pat: parsed.pat.trim() }
    }
    return { pat: text }
  },
  serializeCredential: (c) => JSON.stringify({ pat: c.pat }),
  async read(ctx) {
    const now = ctx.now()
    try {
      return { reading: okReading('qoder', 'cloud', await readQuotas(ctx, ctx.credential.pat), now) }
    } catch (err) {
      return { reading: errorFromUnknown('qoder', 'cloud', err, now) }
    }
  },
}
