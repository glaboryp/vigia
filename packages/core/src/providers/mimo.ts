import { ProviderError, classifyHttp, errorFromUnknown, fetchJson } from '../http.js'
import type { Quota } from '../types.js'
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

export interface MimoCredential {
  cookie: string
}

const BASE = 'https://platform.xiaomimimo.com'
const API = `${BASE}/api/v1/tokenPlan`
const QUOTA_NAME = 'month_total_token'

export function madridOffset(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', timeZoneName: 'longOffset' }).formatToParts(now)
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+01:00'
  const match = /GMT([+-]\d{2}):?(\d{2})?/.exec(name)
  return match ? `${match[1]}:${match[2] ?? '00'}` : '+01:00'
}

async function get(ctx: ProviderContext<MimoCredential>, path: string, offset: string): Promise<JsonRecord> {
  const { status, body } = await fetchJson(ctx, `${API}/${path}`, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      Cookie: ctx.credential.cookie,
      Accept: 'application/json, text/plain, */*',
      Origin: BASE,
      Referer: `${BASE}/#/console/balance`,
      'User-Agent': BROWSER_USER_AGENT,
      'x-timeZone': `UTC${offset}`,
    },
  })
  if (isRedirect(status)) throw new ProviderError('auth', 'MiMo redirige al inicio de sesión')
  const kind = classifyHttp(status)
  if (kind) throw new ProviderError(kind, `MiMo HTTP ${status}`)
  if (!isRecord(body)) throw new ProviderError('parse', `Unexpected MiMo ${path} response`)
  const code = pickNumber(body, 'code')
  if (code === 401 || code === 403) throw new ProviderError('auth', `MiMo code ${code}`)
  if (code !== 0) throw new ProviderError('parse', `MiMo ${path} code ${String(body.code)}`)
  if (!isRecord(body.data)) throw new ProviderError('parse', `MiMo ${path} has no data`)
  return body.data
}

function parsePeriodEnd(value: unknown, offset: string): string {
  const text = nonEmptyString(value)
  const local = text && /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(text)
  const iso = local ? toIso(`${local[1]}T${local[2]}${offset}`) : toIso(text)
  if (!iso) throw new ProviderError('parse', 'MiMo plan has no period end')
  return iso
}

function parseQuota(usage: JsonRecord, detail: JsonRecord, offset: string): Quota {
  if (detail.expired === true) throw new ProviderError('unavailable', 'El plan de MiMo ha caducado')
  const monthUsage = usage.monthUsage
  const items = isRecord(monthUsage) && Array.isArray(monthUsage.items) ? monthUsage.items.filter(isRecord) : []
  const item = items.find((i) => i.name === QUOTA_NAME) ?? items[0]
  if (!item) throw new ProviderError('parse', 'MiMo usage has no token meter')
  const used = pickNumber(item, 'used')
  const limit = pickNumber(item, 'limit')
  if (used === undefined || limit === undefined || limit <= 0) {
    throw new ProviderError('parse', 'MiMo token meter has no used/limit')
  }
  return {
    provider: 'mimo',
    quotaId: QUOTA_NAME,
    name: 'Tokens del mes',
    window: 'monthly',
    remainingFraction: clampFraction(1 - used / limit),
    remaining: Math.max(0, limit - used),
    total: limit,
    unit: 'créditos',
    resetsAt: parsePeriodEnd(detail.currentPeriodEnd, offset),
  }
}

export const mimoProvider: Provider<MimoCredential> = {
  id: 'mimo',
  source: 'local',
  parseCredential: (raw) => parseCookieCredential(raw, 'MiMo'),
  serializeCredential: (c) => JSON.stringify(c),
  async read(ctx) {
    const now = ctx.now()
    try {
      const offset = madridOffset(now)
      const [usage, detail] = await Promise.all([get(ctx, 'usage', offset), get(ctx, 'detail', offset)])
      return { reading: okReading('mimo', 'local', [parseQuota(usage, detail, offset)], now) }
    } catch (err) {
      return { reading: errorFromUnknown('mimo', 'local', err, now) }
    }
  },
}
