import { ProviderError, classifyHttp, errorFromUnknown, fetchJson } from '../http.js'
import type { Quota, Window } from '../types.js'
import { okReading, type Provider } from './contract.js'
import { clampFraction, isRecord, pick, pickNumber, toIso, type JsonRecord } from './util.js'

const SESSION_URL = 'https://www.codebuff.com/api/v1/freebuff/session'

function windowQuota(
  quotaId: string,
  name: string,
  window: Window,
  used: number | undefined,
  limit: number | undefined,
  resetsAt: string | undefined,
): Quota | null {
  if (used === undefined || limit === undefined) throw new ProviderError('parse', `Freebuff ${quotaId} has no usage numbers`)
  if (limit <= 0 || resetsAt === undefined) return null
  const remaining = Math.max(0, limit - used)
  return {
    provider: 'freebuff',
    quotaId,
    name,
    window,
    remainingFraction: clampFraction(remaining / limit),
    remaining,
    total: limit,
    unit: 'sesiones',
    resetsAt,
  }
}

function freeQuotas(free: JsonRecord): Quota[] {
  const quotas: Quota[] = []
  const month = windowQuota(
    'free-month',
    'Freebuff (gratis)',
    'monthly',
    pickNumber(free, 'monthUsed'),
    pickNumber(free, 'monthLimit'),
    toIso(pick(free, 'monthResetAt')),
  )
  if (month) quotas.push(month)

  const weekReset = toIso(pick(free, 'weekResetAt', 'weeklyResetAt'))
  if (weekReset) {
    const week = windowQuota(
      'free-week',
      'Freebuff (gratis, semanal)',
      'weekly',
      pickNumber(free, 'weekUsed'),
      pickNumber(free, 'weekLimit'),
      weekReset,
    )
    if (week) quotas.push(week)
  }
  return quotas
}

function subscriptionQuotas(sub: JsonRecord): Quota[] {
  const usage = sub.usage
  if (sub.tierId === null || sub.tierId === undefined || !isRecord(usage)) return []
  const resetsAt = toIso(pick(usage, 'periodEndsAt')) ?? toIso(pick(sub, 'renewsAt'))
  if (resetsAt === undefined) throw new ProviderError('parse', 'Sin fecha de renovación')
  const month = windowQuota(
    'subscription-month',
    'Freebuff (suscripción)',
    'monthly',
    pickNumber(usage, 'monthUsed'),
    pickNumber(usage, 'monthLimit'),
    resetsAt,
  )
  return month ? [month] : []
}

function parseQuotas(body: unknown): Quota[] {
  if (!isRecord(body)) throw new ProviderError('parse', 'Unexpected Freebuff response')
  const quotas: Quota[] = []
  const errors: ProviderError[] = []
  const attempts: [unknown, (v: JsonRecord) => Quota[]][] = [
    [body.freeWindows, freeQuotas],
    [body.subscription, subscriptionQuotas],
  ]
  for (const [value, parse] of attempts) {
    if (!isRecord(value)) continue
    try {
      quotas.push(...parse(value))
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err
      errors.push(err)
    }
  }
  if (quotas.length > 0) return quotas
  if (errors.length > 0) throw errors[0]!
  throw new ProviderError('unavailable', 'Freebuff no devolvió cuotas')
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
