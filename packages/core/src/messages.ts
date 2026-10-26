import { isStale, type ProviderHealth } from './alerts/health.js'
import type { findSurplus } from './alerts/surplus.js'
import type { TrackedQuota } from './alerts/use-or-lose.js'
import { formatMadrid, formatRelative } from './time.js'
import { PROVIDER_LABELS, type ProviderId, type Source } from './types.js'

export const FIX_HINTS: Record<ProviderId, string> = {
  cursor: 'Abre Cursor para que renueve la sesión',
  mimo: 'Inicia sesión en platform.xiaomimimo.com con Brave',
  opencode: 'Inicia sesión en opencode.ai con Brave',
  antigravity: 'Ejecuta `agy` y vuelve a iniciar sesión',
  codex: 'Repite el login: pnpm --filter agent run login codex',
  grok: 'Repite el login de la nube (ver README)',
  copilot: 'Genera un token nuevo y súbelo (ver README)',
  kilo: 'Genera un token nuevo y súbelo (ver README)',
  qoder: 'Genera un token nuevo y súbelo (ver README)',
  freebuff: 'Genera un token nuevo y súbelo (ver README)',
}

export const LOCAL_PROVIDERS: ProviderId[] = ['codex', 'antigravity', 'mimo', 'opencode']
const OLD_DATA_MS = 6 * 3_600_000
const PROVIDER_ORDER = Object.keys(PROVIDER_LABELS) as ProviderId[]

export const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const MAX_ERROR_CHARS = 200

export function formatPercent(fraction: number): string {
  if (fraction > 0 && fraction < 0.01) return '<1 %'
  if (fraction > 0.99 && fraction < 1) return '>99 %'
  return `${Math.round(fraction * 100)} %`
}

export function formatProgressBar(fraction: number): string {
  const filled = Math.max(fraction > 0 ? 1 : 0, Math.min(10, Math.round(fraction * 10)))
  return `[${'#'.repeat(filled)}${'-'.repeat(10 - filled)}]`
}

export const shortError = (message: string): string =>
  message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message

function displayName(q: TrackedQuota, siblings: number): string {
  const label = escapeHtml(PROVIDER_LABELS[q.provider])
  const name = escapeHtml(q.name)
  return siblings > 1 && name !== label ? `<b>${label}</b> · ${name}` : `<b>${label}</b>`
}

function ageSuffix(q: TrackedQuota, now: Date): string {
  const ms = now.getTime() - Date.parse(q.readAt)
  if (ms <= OLD_DATA_MS) return ''
  const hours = Math.floor(ms / 3_600_000)
  return ` · dato de hace ${hours >= 48 ? `${Math.floor(hours / 24)} d` : `${hours} h`}`
}

function amount(q: TrackedQuota): string {
  const unit = q.unit ? ` ${escapeHtml(q.unit)}` : ''
  if (q.remaining !== undefined && q.total !== undefined) return ` (${q.remaining} de ${q.total}${unit})`
  if (q.remaining !== undefined) return ` (${q.remaining}${unit})`
  return ''
}

function quotaLine(q: TrackedQuota, siblings: number, now: Date): string {
  const pct = escapeHtml(formatPercent(q.remainingFraction))
  const bar = formatProgressBar(q.remainingFraction)
  const renewal =
    Date.parse(q.resetsAt) > now.getTime()
      ? `se renueva ${formatMadrid(q.resetsAt)} (${formatRelative(now.toISOString(), q.resetsAt)})`
      : 'renovación pendiente de leer'
  return `• ${displayName(q, siblings)} — te queda ${pct} ${bar}${amount(q)} · ${renewal}${ageSuffix(q, now)}`
}

function siblingCounts(quotas: TrackedQuota[]): Map<ProviderId, number> {
  const counts = new Map<ProviderId, number>()
  for (const q of quotas) counts.set(q.provider, (counts.get(q.provider) ?? 0) + 1)
  return counts
}

export function useOrLoseMessage(quotas: TrackedQuota[], now: Date): string {
  const counts = siblingCounts(quotas)
  const lines = quotas.map((q) => quotaLine(q, counts.get(q.provider) ?? 1, now))
  return `⏳ <b>Úsalo o piérdelo</b>\nTe queda saldo y está a punto de renovarse:\n\n${lines.join('\n\n')}`
}

export function renewedMessage(q: TrackedQuota): string {
  const line = `${displayName(q, 2)} — te queda ${escapeHtml(formatPercent(q.remainingFraction))} ${formatProgressBar(q.remainingFraction)}${amount(q)}`
  return `🔄 <b>Cuota renovada</b>\nYa tienes cuota otra vez: ${line} · próxima renovación ${formatMadrid(q.resetsAt)}`
}

export function brokenMessage(h: ProviderHealth): string {
  const label = escapeHtml(PROVIDER_LABELS[h.provider])
  const hint = escapeHtml(FIX_HINTS[h.provider]).replace(/`([^`]+)`/g, '<code>$1</code>')
  const error = h.lastError ? `\nÚltimo error: ${escapeHtml(shortError(h.lastError.message))}` : ''
  return `⚠️ <b>No puedo leer ${label}</b>${error}\n${hint}`
}

export function recoveredMessage(provider: ProviderId): string {
  return `✅ <b>${escapeHtml(PROVIDER_LABELS[provider])}</b> vuelve a funcionar`
}

export function noDataText(provider: ProviderId): string {
  return LOCAL_PROVIDERS.includes(provider) ? 'sin datos del portátil' : 'sin datos'
}

export function statusMessage(
  quotas: TrackedQuota[],
  health: ProviderHealth[],
  now: Date,
  enabled: readonly ProviderId[],
): string {
  const healthBy = new Map(health.map((h) => [h.provider, h]))
  const lines: string[] = []
  for (const provider of PROVIDER_ORDER) {
    if (!enabled.includes(provider)) continue
    const own = quotas.filter((q) => q.provider === provider)
    const h = healthBy.get(provider)
    const label = `<b>${escapeHtml(PROVIDER_LABELS[provider])}</b>`
    if (h?.lastError && h.brokenNotified) {
      lines.push(`• ${label} — ⚠️ no puedo leerlo: ${escapeHtml(shortError(h.lastError.message))}`)
      continue
    }
    if (own.length === 0) {
      lines.push(`• ${label} — ${noDataText(provider)}`)
      continue
    }
    const source: Source = LOCAL_PROVIDERS.includes(provider) ? 'local' : 'cloud'
    const stale = h !== undefined && isStale(h, source, now) ? ' (desactualizado)' : ''
    for (const q of own) lines.push(`${quotaLine(q, own.length, now)}${stale}`)
  }
  if (lines.length === 0) return '📊 <b>Estado de tus cuotas</b>\nTodavía no hay datos.'
  return `📊 <b>Estado de tus cuotas</b>\n${lines.join('\n\n')}`
}

export function surplusMessage(items: ReturnType<typeof findSurplus>): string {
  if (items.length === 0) return ''
  const lines = items.map((i) => {
    const repeated = items.filter((o) => o.provider === i.provider).length > 1
    const name = escapeHtml(PROVIDER_LABELS[i.provider])
    const quota = repeated ? ` · ${escapeHtml(i.quotaId)}` : ''
    return `• <b>${name}</b>${quota} — has usado de media un ${Math.round(i.avgUsed * 100)} %`
  })
  return ['💡 <b>¿Te sobra el plan?</b>', 'Los últimos periodos has consumido poco:', ...lines, 'Quizá te compense un plan más barato.'].join('\n')
}
