import { ProviderError, classifyHttp, errorFromUnknown, fetchJson } from '../http.js'
import type { Quota } from '../types.js'
import { okReading, type Provider } from './contract.js'
import { clampFraction, isRecord, pick, pickNumber, toIso } from './util.js'

const USER_URL = 'https://api.github.com/copilot_internal/user'

function parseQuotas(body: unknown, provider: 'copilot'): Quota[] {
  if (!isRecord(body)) throw new ProviderError('parse', 'Unexpected Copilot response')
  const snapshots = body.quota_snapshots
  const premium = isRecord(snapshots) ? snapshots.premium_interactions : undefined
  if (!isRecord(premium)) throw new ProviderError('unavailable', 'Sin cuota premium de Copilot')
  if (premium.unlimited === true) return []

  const entitlement = pickNumber(premium, 'entitlement')
  const remaining = pickNumber(premium, 'remaining')
  let percent = pickNumber(premium, 'percent_remaining', 'percentRemaining')
  if (percent === undefined && entitlement !== undefined && entitlement > 0 && remaining !== undefined) {
    percent = (remaining / entitlement) * 100
  }
  if (percent === undefined) throw new ProviderError('parse', 'Copilot premium quota has no percentage')

  const resetsAt = toIso(pick(body, 'quota_reset_date_utc', 'quota_reset_date'))
  if (!resetsAt) throw new ProviderError('parse', 'Copilot quota has no reset date')

  const quota: Quota = {
    provider,
    quotaId: 'premium',
    name: 'Premium',
    window: 'monthly',
    remainingFraction: clampFraction(percent / 100),
    unit: 'créditos',
    resetsAt,
  }
  if (entitlement !== undefined && entitlement > 0 && remaining !== undefined) {
    quota.remaining = Math.max(0, remaining)
    quota.total = entitlement
  }
  return [quota]
}

export const copilotProvider: Provider<string> = {
  id: 'copilot',
  source: 'cloud',
  parseCredential: (raw) => raw.trim(),
  serializeCredential: (c) => c,
  async read(ctx) {
    const now = ctx.now()
    try {
      const { status, body } = await fetchJson(ctx, USER_URL, {
        method: 'GET',
        headers: {
          Authorization: `token ${ctx.credential}`,
          Accept: 'application/json',
          'User-Agent': 'VigIA',
          'Editor-Version': 'vscode/1.96.2',
          'Editor-Plugin-Version': 'copilot-chat/0.26.7',
          'X-Github-Api-Version': '2025-04-01',
        },
      })
      const kind = classifyHttp(status)
      if (kind) throw new ProviderError(kind, `Copilot HTTP ${status}`)
      return { reading: okReading('copilot', 'cloud', parseQuotas(body, 'copilot'), now) }
    } catch (err) {
      return { reading: errorFromUnknown('copilot', 'cloud', err, now) }
    }
  },
}
