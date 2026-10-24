import { ProviderError, classifyHttp, errorFromUnknown, fetchJson } from '../http.js'
import type { Quota, Window } from '../types.js'
import { okReading, type Provider } from './contract.js'
import { type JsonRecord, clampFraction, decodeJwtPayload, isRecord, nonEmptyString, pick, pickNumber, toIso } from './util.js'

export interface CursorCredential {
  accessToken: string
}

const USAGE_URL = 'https://cursor.com/api/usage-summary'
const WEEKLY_MAX_MS = 8 * 24 * 3600 * 1000

function parseCredential(raw: string): CursorCredential {
  const text = raw.trim()
  let accessToken: string | undefined
  if (text.startsWith('{')) {
    const root: unknown = JSON.parse(text)
    if (isRecord(root)) accessToken = nonEmptyString(pick(root, 'accessToken', 'access_token'))
  } else {
    accessToken = nonEmptyString(text)
  }
  if (!accessToken) throw new Error('Cursor credential has no access token')
  return { accessToken }
}

interface Usage {
  percent: number
  used?: number
  limit?: number
}

function amounts(src: JsonRecord): { used?: number; limit?: number } {
  const used = pickNumber(src, 'used')
  const breakdown = isRecord(src.breakdown) ? src.breakdown : undefined
  let limit = pickNumber(src, 'limit') ?? (breakdown ? pickNumber(breakdown, 'total') : undefined)
  if (limit === undefined) {
    const remaining = pickNumber(src, 'remaining')
    if (remaining !== undefined) limit = remaining + (used ?? 0)
  }
  const out: { used?: number; limit?: number } = {}
  if (used !== undefined) out.used = used
  if (limit !== undefined && limit > 0) out.limit = limit
  return out
}

function usageOf(src: unknown): Usage | undefined {
  if (!isRecord(src)) return undefined
  const { used, limit } = amounts(src)
  const reported = pickNumber(src, 'totalPercentUsed', 'total_percent_used')
  const percent = reported ?? (used !== undefined && limit !== undefined ? (used / limit) * 100 : undefined)
  if (percent === undefined) return undefined
  const usage: Usage = { percent }
  if (used !== undefined && limit !== undefined) {
    usage.used = used
    usage.limit = limit
  }
  return usage
}

function findUsage(root: JsonRecord): Usage | undefined {
  const individual = root.individualUsage
  if (isRecord(individual)) {
    const found = usageOf(individual.plan) ?? usageOf(individual.overall)
    if (found) return found
  }
  const team = root.teamUsage
  return isRecord(team) ? usageOf(team.pooled) : undefined
}

function parseQuotas(body: unknown): Quota[] {
  if (!isRecord(body)) throw new ProviderError('parse', 'Unexpected Cursor usage response')
  if (body.isUnlimited === true) return []
  const usage = findUsage(body)
  if (!usage) throw new ProviderError('unavailable', 'Cursor no informa de uso del plan')
  const end = toIso(body.billingCycleEnd)
  if (!end) throw new ProviderError('parse', 'Cursor usage has no billing cycle end')
  const start = toIso(body.billingCycleStart)
  const window: Window =
    start !== undefined && Date.parse(end) - Date.parse(start) <= WEEKLY_MAX_MS ? 'weekly' : 'monthly'
  const quota: Quota = {
    provider: 'cursor',
    quotaId: 'plan',
    name: 'Plan',
    window,
    remainingFraction: clampFraction(1 - usage.percent / 100),
    resetsAt: end,
  }
  if (usage.used !== undefined && usage.limit !== undefined) {
    quota.remaining = Math.max(0, usage.limit - usage.used) / 100
    quota.total = usage.limit / 100
    quota.unit = 'USD'
  }
  return [quota]
}

export const cursorProvider: Provider<CursorCredential> = {
  id: 'cursor',
  source: 'cloud',
  parseCredential,
  serializeCredential: (c) => JSON.stringify(c),
  async read(ctx) {
    const now = ctx.now()
    try {
      const token = ctx.credential.accessToken
      const claims = decodeJwtPayload(token)
      const exp = claims?.exp
      if (typeof exp === 'number' && exp * 1000 <= now.getTime()) {
        throw new ProviderError('auth', 'Token de Cursor caducado; vuelve a iniciar sesión')
      }
      const sub = nonEmptyString(claims?.sub)?.replace(/^auth0\|/, '')
      if (!sub) throw new ProviderError('auth', 'Token de Cursor inválido')
      const { status, body } = await fetchJson(ctx, USAGE_URL, {
        method: 'GET',
        headers: {
          Cookie: `WorkosCursorSessionToken=${sub}%3A%3A${token}`,
          Origin: 'https://cursor.com',
          Referer: 'https://cursor.com',
          Accept: 'application/json',
        },
      })
      const kind = classifyHttp(status)
      if (kind) throw new ProviderError(kind, `Cursor HTTP ${status}`)
      return { reading: okReading('cursor', 'cloud', parseQuotas(body), now) }
    } catch (err) {
      return { reading: errorFromUnknown('cursor', 'cloud', err, now) }
    }
  },
}
