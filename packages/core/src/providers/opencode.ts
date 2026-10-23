import { ProviderError, classifyHttp, errorFromUnknown, fetchJson } from '../http.js'
import type { Quota, Window } from '../types.js'
import { okReading, type Provider, type ProviderContext } from './contract.js'
import {
  BROWSER_USER_AGENT,
  type JsonRecord,
  clampFraction,
  isRecord,
  isRedirect,
  nonEmptyString,
  parseCookieCredential,
  pickNumber,
  toIso,
} from './util.js'

export interface OpencodeCredential {
  cookie: string
}

const ORGS_URL = 'https://opencode.ai/console/api/orgs'
const STATUS_URL = 'https://opencode.ai/console/api/go/status'
const MICRO_CENTS_PER_USD = 100_000_000

const METERS: ReadonlyArray<{ key: string; id: string; name: string; window: Window }> = [
  { key: 'fiveHour', id: '5h', name: '5 horas', window: '5h' },
  { key: 'week', id: 'weekly', name: 'Semanal', window: 'weekly' },
  { key: 'month', id: 'monthly', name: 'Mensual', window: 'monthly' },
]

async function get(ctx: ProviderContext<OpencodeCredential>, url: string, orgId?: string): Promise<unknown> {
  const headers: Record<string, string> = {
    Cookie: ctx.credential.cookie,
    Accept: 'application/json',
    'User-Agent': BROWSER_USER_AGENT,
  }
  if (orgId) headers['x-org-id'] = orgId
  const { status, body } = await fetchJson(ctx, url, { method: 'GET', redirect: 'manual', headers })
  if (isRedirect(status)) throw new ProviderError('auth', 'opencode redirige al inicio de sesión')
  const kind = classifyHttp(status)
  if (kind) throw new ProviderError(kind, `opencode HTTP ${status}`)
  return body
}

function firstOrgId(body: unknown): string {
  if (!Array.isArray(body)) throw new ProviderError('parse', 'Unexpected opencode orgs response')
  for (const row of body) {
    const id = isRecord(row) ? nonEmptyString(row.id) : undefined
    if (id) return id
  }
  throw new ProviderError('unavailable', 'opencode no tiene ningún workspace')
}

function parseMeter(meter: JsonRecord, spec: (typeof METERS)[number], fallbackReset: string | undefined): Quota | undefined {
  const used = pickNumber(meter, 'usedMicroCents')
  const limit = pickNumber(meter, 'limitMicroCents')
  if (used === undefined || limit === undefined || limit <= 0) {
    throw new ProviderError('parse', `opencode meter ${spec.key} has no used/limit`)
  }
  const resetsAt = toIso(meter.resetsAt) ?? fallbackReset
  if (!resetsAt) return undefined
  return {
    provider: 'opencode',
    quotaId: spec.id,
    name: spec.name,
    window: spec.window,
    remainingFraction: clampFraction(1 - used / limit),
    remaining: Math.max(0, limit - used) / MICRO_CENTS_PER_USD,
    total: limit / MICRO_CENTS_PER_USD,
    unit: 'USD',
    resetsAt,
  }
}

function parseQuotas(body: unknown): Quota[] {
  if (body === null) throw new ProviderError('unavailable', 'Sin suscripción a opencode Go')
  if (!isRecord(body) || !('access' in body)) throw new ProviderError('parse', 'Unexpected opencode Go status response')
  if (body.access === null) throw new ProviderError('unavailable', 'Sin suscripción a opencode Go')
  if (!isRecord(body.access) || !isRecord(body.access.meters)) {
    throw new ProviderError('parse', 'Unexpected opencode Go access')
  }
  const meters = body.access.meters
  const endsAt = toIso(body.access.endsAt)
  const quotas: Quota[] = []
  let present = 0
  for (const spec of METERS) {
    const meter = meters[spec.key]
    if (!isRecord(meter)) continue
    present++
    const quota = parseMeter(meter, spec, spec.window === 'monthly' ? endsAt : undefined)
    if (quota) quotas.push(quota)
  }
  if (present === 0 || quotas.length === 0) throw new ProviderError('parse', 'opencode Go status has no usable meters')
  return quotas
}

export const opencodeProvider: Provider<OpencodeCredential> = {
  id: 'opencode',
  source: 'local',
  parseCredential: (raw) => parseCookieCredential(raw, 'opencode'),
  serializeCredential: (c) => JSON.stringify(c),
  async read(ctx) {
    const now = ctx.now()
    try {
      const orgId = firstOrgId(await get(ctx, ORGS_URL))
      const quotas = parseQuotas(await get(ctx, STATUS_URL, orgId))
      return { reading: okReading('opencode', 'local', quotas, now) }
    } catch (err) {
      return { reading: errorFromUnknown('opencode', 'local', err, now) }
    }
  },
}
