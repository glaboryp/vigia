import { ProviderError, classifyHttp, errorFromUnknown, fetchJson } from '../http.js'
import type { Quota } from '../types.js'
import { okReading, type Provider } from './contract.js'
import { clampFraction, isRecord, pick, pickNumber, toIso, type JsonRecord } from './util.js'

const URL_BASE = 'https://app.kilo.ai/api/trpc/kiloPass.getState'
const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due'])
const NO_PASS = 'Sin Kilo Pass activo'

function buildUrl(): string {
  return `${URL_BASE}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: null, meta: { values: ['undefined'] } } }))}`
}

function extractState(body: unknown): unknown {
  if (!Array.isArray(body) || !isRecord(body[0])) throw new ProviderError('parse', 'Unexpected Kilo response')
  const entry = body[0]
  if (isRecord(entry.error)) {
    const inner = isRecord(entry.error.json) ? entry.error.json : entry.error
    const data = isRecord(inner.data) ? inner.data : {}
    if (data.code === 'UNAUTHORIZED' || data.code === 'FORBIDDEN' || data.httpStatus === 401 || data.httpStatus === 403) {
      throw new ProviderError('auth', 'Kilo rechazó la credencial')
    }
    throw new ProviderError('unavailable', 'Kilo devolvió un error')
  }
  const data = isRecord(entry.result) ? entry.result.data : undefined
  if (!isRecord(data) && data !== null) throw new ProviderError('parse', 'Unexpected Kilo response')
  if (isRecord(data) && 'json' in data) return data.json
  return data
}

function parseQuotas(body: unknown): Quota[] {
  const state = extractState(body)
  if (!isRecord(state)) throw new ProviderError('unavailable', NO_PASS)
  const pass: JsonRecord | undefined = 'subscription' in state ? (isRecord(state.subscription) ? state.subscription : undefined) : state
  if (!pass) throw new ProviderError('unavailable', NO_PASS)

  const status = pick(pass, 'status')
  if (typeof status === 'string' && !ACTIVE_STATUSES.has(status.toLowerCase())) {
    throw new ProviderError('unavailable', NO_PASS)
  }

  const total = (pickNumber(pass, 'currentPeriodBaseCreditsUsd') ?? 0) + (pickNumber(pass, 'currentPeriodBonusCreditsUsd') ?? 0)
  if (total <= 0) throw new ProviderError('unavailable', NO_PASS)
  const used = pickNumber(pass, 'currentPeriodUsageUsd') ?? 0
  const remaining = Math.max(0, total - used)

  const resetsAt = toIso(pick(pass, 'nextBillingAt', 'nextRenewalAt'))
  if (!resetsAt) throw new ProviderError('parse', 'Kilo Pass has no billing date')

  return [
    {
      provider: 'kilo',
      quotaId: 'pass',
      name: 'Kilo Pass',
      window: 'monthly',
      remainingFraction: clampFraction(remaining / total),
      remaining,
      total,
      unit: 'USD',
      resetsAt,
    },
  ]
}

export const kiloProvider: Provider<string> = {
  id: 'kilo',
  source: 'cloud',
  parseCredential: (raw) => raw.trim(),
  serializeCredential: (c) => c,
  async read(ctx) {
    const now = ctx.now()
    try {
      const { status, body } = await fetchJson(ctx, buildUrl(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${ctx.credential}`, Accept: 'application/json' },
      })
      const kind = classifyHttp(status)
      if (kind) throw new ProviderError(kind, `Kilo HTTP ${status}`)
      return { reading: okReading('kilo', 'cloud', parseQuotas(body), now) }
    } catch (err) {
      return { reading: errorFromUnknown('kilo', 'cloud', err, now) }
    }
  },
}
