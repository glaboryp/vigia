import {
  escapeHtml,
  formatMadrid,
  formatRelative,
  isStale,
  PROVIDER_LABELS,
  type findSurplus,
  type PeriodClose,
  type ProviderId,
} from 'core'
import type { StoredHealth, StoredQuota } from './db.js'

export interface StatusPageData {
  quotas: StoredQuota[]
  health: StoredHealth[]
  closes: PeriodClose[]
  surplus: ReturnType<typeof findSurplus>
  now: Date
}

const HISTORY_LIMIT = 12
const OLD_DATA_MS = 3_600_000
const PROVIDERS = Object.keys(PROVIDER_LABELS) as ProviderId[]

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--text:#1b1f24;--muted:#5d6672;--line:#dde1e6;--ok:#2f9e5b;--warn:#d98a00;--bad:#d1453b;--track:#e6e9ee;--badge-bg:#eef0f3}
@media (prefers-color-scheme: dark){:root{--bg:#111418;--card:#1a1e24;--text:#e8eaed;--muted:#9aa4b0;--line:#2b313a;--ok:#4cc27f;--warn:#f0a82b;--bad:#f06a60;--track:#2b313a;--badge-bg:#262c34}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:16px}
h1{font-size:1.4rem;margin:8px 0 16px}
h2{font-size:1.15rem;margin:28px 0 10px}
h3{font-size:1rem;margin:0 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:12px}
.quota{margin-bottom:14px}
.quota:last-child{margin-bottom:0}
.row{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.bar{height:10px;background:var(--track);border-radius:5px;overflow:hidden;margin:6px 0}
.bar>span{display:block;height:100%;background:var(--ok)}
.bar.warn>span{background:var(--warn)}
.bar.bad>span{background:var(--bad)}
.muted{color:var(--muted);font-size:.9rem}
.badge{display:inline-block;background:var(--badge-bg);border-radius:999px;padding:1px 8px;font-size:.8rem;margin-left:6px}
.badge.bad{color:var(--bad)}
.badge.warn{color:var(--warn)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line)}
footer{margin:28px 0 8px;color:var(--muted);font-size:.85rem}
`

function pct(fraction: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100)
}

function ageText(readAt: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(readAt)) / 60_000))
  if (minutes < 60) return `dato de hace ${minutes} min`
  const hours = Math.floor(minutes / 60)
  return hours >= 48 ? `dato de hace ${Math.floor(hours / 24)} d` : `dato de hace ${hours} h`
}

function quotaHtml(q: StoredQuota, now: Date): string {
  const used = pct(1 - q.remainingFraction)
  const left = pct(q.remainingFraction)
  const level = left <= 10 ? ' bad' : left <= 25 ? ' warn' : ''
  const amount =
    q.remaining !== undefined
      ? ` (${q.remaining}${q.total !== undefined ? ` de ${q.total}` : ''}${q.unit ? ` ${escapeHtml(q.unit)}` : ''})`
      : ''
  const old = now.getTime() - Date.parse(q.readAt) > OLD_DATA_MS
  return `<div class="quota">
<div class="row"><strong>${escapeHtml(q.name)}</strong><span>${left}% libre · ${used}% usado${amount}</span></div>
<div class="bar${level}" role="img" aria-label="${used}% usado"><span style="width:${used}%"></span></div>
<div class="muted">se renueva ${escapeHtml(formatMadrid(q.resetsAt))} (${escapeHtml(formatRelative(now.toISOString(), q.resetsAt))}) · <span${old ? ' class="badge warn"' : ''}>${escapeHtml(ageText(q.readAt, now))}</span></div>
</div>`
}

function currentSection(data: StatusPageData): string {
  const cards = PROVIDERS.flatMap((id) => {
    const quotas = data.quotas.filter((q) => q.provider === id)
    const health = data.health.find((h) => h.provider === id)
    if (quotas.length === 0 && health === undefined) return []
    const source = quotas[0]?.source ?? 'cloud'
    const badges: string[] = []
    if (health && health.consecutiveFailures > 0 && health.lastError) {
      badges.push(`<span class="badge bad">no puedo leerlo: ${escapeHtml(health.lastError.message)}</span>`)
    }
    if (health && isStale(health, source, data.now)) badges.push('<span class="badge warn">desactualizado</span>')
    const body = quotas.length === 0 ? '<div class="muted">Sin datos todavía</div>' : quotas.map((q) => quotaHtml(q, data.now)).join('\n')
    return [`<section class="card"><h3>${escapeHtml(PROVIDER_LABELS[id])}${badges.join('')}</h3>\n${body}</section>`]
  })
  return `<h2>Estado actual</h2>\n${cards.length > 0 ? cards.join('\n') : '<p class="muted">Sin datos todavía</p>'}`
}

function historySection(data: StatusPageData): string {
  const blocks = PROVIDERS.flatMap((id) => {
    const byQuota = new Map<string, PeriodClose[]>()
    for (const c of data.closes) {
      if (c.provider !== id) continue
      byQuota.set(c.quotaId, [...(byQuota.get(c.quotaId) ?? []), c])
    }
    return [...byQuota.entries()].map(([quotaId, closes]) => {
      const nameOf = data.quotas.find((q) => q.provider === id && q.quotaId === quotaId)?.name ?? quotaId
      const recent = closes
        .sort((a, b) => Date.parse(a.periodResetAt) - Date.parse(b.periodResetAt))
        .slice(-HISTORY_LIMIT)
        .reverse()
      const rows = recent
        .map((c) => `<tr class="close"><td>${escapeHtml(formatMadrid(c.periodResetAt))}</td><td>${pct(c.usedFraction)}%</td></tr>`)
        .join('\n')
      return `<section class="card"><h3>${escapeHtml(PROVIDER_LABELS[id])} · ${escapeHtml(nameOf)}</h3>
<div class="scroll"><table><thead><tr><th>Periodo</th><th>Usado</th></tr></thead><tbody>
${rows}
</tbody></table></div></section>`
    })
  })
  return `<h2>Historial</h2>\n${blocks.length > 0 ? blocks.join('\n') : '<p class="muted">Sin cierres de periodo todavía</p>'}`
}

function surplusSection(data: StatusPageData): string {
  const body =
    data.surplus.length === 0
      ? '<p class="muted">Nada que señalar</p>'
      : `<ul>${data.surplus
          .map((s) => {
            const name = data.quotas.find((q) => q.provider === s.provider && q.quotaId === s.quotaId)?.name ?? s.quotaId
            return `<li>${escapeHtml(PROVIDER_LABELS[s.provider])} · ${escapeHtml(name)}: consumo medio ${pct(s.avgUsed)}% en los últimos periodos</li>`
          })
          .join('')}</ul>`
  return `<h2>¿Me sobra el plan?</h2>\n<section class="card">${body}</section>`
}

export function renderStatusPage(data: StatusPageData): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VigIA</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>VigIA</h1>
${currentSection(data)}
${historySection(data)}
${surplusSection(data)}
<footer>Actualizado ${escapeHtml(formatMadrid(data.now.toISOString()))}</footer>
</main>
</body>
</html>
`
}
