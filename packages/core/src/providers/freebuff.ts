import { ProviderError, classifyHttp, errorFromUnknown, fetchJson } from '../http.js'
import type { Quota } from '../types.js'
import { okReading, type Provider } from './contract.js'
import { clampFraction, isRecord, pick, pickNumber, toIso, type JsonRecord } from './util.js'

const SESSION_URL = 'https://www.codebuff.com/api/v1/freebuff/session'

function freebuckQuotas(freebucks: JsonRecord): Quota[] {
  const daily = freebucks.daily
  if (!isRecord(daily)) return []

  const limit = pickNumber(daily, 'limit')
  const remaining = pickNumber(daily, 'remaining')
  const spent = pickNumber(daily, 'spent')
  const resetsAt = toIso(pick(daily, 'resetAt'))
  if (limit === undefined || resetsAt === undefined || (remaining === undefined && spent === undefined)) {
    throw new ProviderError('parse', 'Freebuff freebucks.daily has incomplete quota data')
  }
  if (limit <= 0) return []

  const left = Math.max(0, Math.min(limit, remaining ?? limit - spent!))
  return [{
    provider: 'freebuff',
    quotaId: 'freebucks-daily',
    name: 'Freebuff (gratis, diario)',
    window: 'daily',
    remainingFraction: clampFraction(left / limit),
    remaining: left,
    total: limit,
    unit: 'Freebucks',
    resetsAt,
  }]
}

function parseQuotas(body: unknown): Quota[] {
  if (!isRecord(body)) throw new ProviderError('parse', 'Unexpected Freebuff response')
  if (!isRecord(body.freebucks)) throw new ProviderError('unavailable', 'Freebuff no devolvió la cuota diaria')
  const quotas = freebuckQuotas(body.freebucks)
  if (quotas.length === 0) throw new ProviderError('unavailable', 'Freebuff no devolvió la cuota diaria')
  return quotas
}

export const freebuffProvider: Provider<string> = {
  id: 'freebuff',
  source: 'cloud',
  parseCredential: (raw) => raw.trim(),
  serializeCredential: (c) => c,
  async read(ctx) {
    const now = ctx.now()
    try {
      const { status, body } = await fetchJson(ctx, SESSION_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${ctx.credential}`, Accept: 'application/json' },
      })
      const kind = classifyHttp(status)
      if (kind) throw new ProviderError(kind, `Freebuff HTTP ${status}`)
      return { reading: okReading('freebuff', 'cloud', parseQuotas(body), now) }
    } catch (err) {
      return { reading: errorFromUnknown('freebuff', 'cloud', err, now) }
    }
  },
}
