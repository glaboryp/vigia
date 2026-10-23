import {
  escapeHtml,
  formatMadrid,
  formatPercent,
  LOCAL_PROVIDERS,
  PROVIDER_LABELS,
  sortByPriority,
  statusMessage,
  type ProviderId,
} from 'core'
import type { CronDeps } from './cron.js'
import { enabledProviders, runCloudProviders } from './cron.js'
import { Repo, type StoredHealth, type StoredQuota } from './db.js'
import type { Env } from './env.js'
import { processReadings } from './pipeline.js'

const MAX_TEXT = 4000

export function fitTelegram(text: string): string {
  if (text.length <= MAX_TEXT) return text
  const cut = text.slice(0, MAX_TEXT)
  const lineEnd = cut.lastIndexOf('\n')
  return `${lineEnd > 0 ? cut.slice(0, lineEnd) : cut}\n…`
}

export async function sendMessage(
  env: Env,
  text: string,
  fetchFn?: typeof fetch,
  timeoutMs = 10_000,
): Promise<boolean> {
  const doFetch = fetchFn ?? ((input, init) => fetch(input, init))
  try {
    const res = await doFetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: fitTelegram(text),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    await res.body?.cancel()
    if (!res.ok) console.error(`telegram send failed: HTTP ${res.status}`)
    return res.ok
  } catch (err) {
    console.error(`telegram send failed: ${err instanceof Error ? err.name : 'error'}`)
    return false
  }
}

const HELP = [
  '🤖 <b>VigIA</b> — comandos',
  '/estado [herramienta] — estado de tus cuotas',
  '/prioridad — qué usar primero',
  '/historial &lt;herramienta&gt; — últimos periodos cerrados',
  '/actualizar — leer las cuotas ahora',
  '/silenciar &lt;herramienta&gt; &lt;días&gt; — pausar avisos',
  '/activar &lt;herramienta&gt; — reanudar avisos',
  '/ayuda — esta lista',
].join('\n')

const MAX_MUTE_DAYS = 365
const HISTORY_SIZE = 6
const PROVIDERS = Object.keys(PROVIDER_LABELS) as ProviderId[]

const normalize = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

function findProvider(name: string): ProviderId | undefined {
  const wanted = normalize(name)
  if (!wanted) return undefined
  return PROVIDERS.find((id) => normalize(id) === wanted || normalize(PROVIDER_LABELS[id]) === wanted)
}

const unknownTool = (name: string): string =>
  `No conozco «${escapeHtml(name)}». Opciones: ${PROVIDERS.map((id) => PROVIDER_LABELS[id]).join(', ')}`

function ageText(ms: number): string {
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 1) return `${Math.max(0, Math.floor(ms / 60_000))} min`
  return hours >= 48 ? `${Math.floor(hours / 24)} d` : `${hours} h`
}

function localAgeNote(quotas: StoredQuota[], now: Date): string {
  const parts = LOCAL_PROVIDERS.map((id) => {
    const readings = quotas.filter((q) => q.provider === id).map((q) => Date.parse(q.readAt))
    const age = readings.length === 0 ? 'sin datos' : `hace ${ageText(now.getTime() - Math.max(...readings))}`
    return `${escapeHtml(PROVIDER_LABELS[id])} (${age})`
  })
  return `ℹ️ Antigravity, MiMo Code y opencode dependen del portátil; último dato: ${parts.join(', ')}`
}

function priorityMessage(quotas: StoredQuota[], now: Date): string {
  const usable = sortByPriority(quotas.filter((q) => q.remainingFraction > 0 && Date.parse(q.resetsAt) > now.getTime()))
  if (usable.length === 0) return 'No hay cuotas con saldo que se renueven pronto'
  const lines = usable.map((q) => {
    const siblings = usable.filter((o) => o.provider === q.provider).length
    const label = escapeHtml(PROVIDER_LABELS[q.provider])
    const name = siblings > 1 ? ` · ${escapeHtml(q.name)}` : ''
    return `• <b>${label}</b>${name} — ${escapeHtml(formatPercent(q.remainingFraction))} · se renueva ${formatMadrid(q.resetsAt)}`
  })
  return ['🎯 <b>Qué usar primero</b>', ...lines].join('\n')
}

async function historyMessage(repo: Repo, provider: ProviderId): Promise<string> {
  const label = PROVIDER_LABELS[provider]
  const closes = (await repo.getPeriodCloses(provider))
    .sort((a, b) => Date.parse(b.periodResetAt) - Date.parse(a.periodResetAt))
    .slice(0, HISTORY_SIZE)
  if (closes.length === 0) return `Aún no hay historial de ${escapeHtml(label)}`
  const multiple = new Set(closes.map((c) => c.quotaId)).size > 1
  const lines = closes.map(
    (c) => `• ${formatMadrid(c.periodResetAt)}${multiple ? ` (${escapeHtml(c.quotaId)})` : ''} → usado ${Math.round(c.usedFraction * 100)} %`,
  )
  return [`📈 <b>Historial de ${escapeHtml(label)}</b>`, ...lines].join('\n')
}

async function mute(env: Env, args: string[], now: Date): Promise<string> {
  const usage = 'Uso: /silenciar &lt;herramienta&gt; &lt;días&gt; (1 a 365)'
  const rawDays = args.at(-1)
  const toolName = args.slice(0, -1).join(' ')
  if (rawDays === undefined || toolName === '' || !/^\d+$/.test(rawDays)) return usage
  const days = Number(rawDays)
  if (days < 1 || days > MAX_MUTE_DAYS) return usage
  const provider = findProvider(toolName)
  if (provider === undefined) return unknownTool(toolName)
  const repo = new Repo(env.DB, env.CREDENTIALS_KEY)
  const mutedUntil = new Date(now.getTime() + days * 86_400_000).toISOString()
  await repo.putHealth({ ...(await currentHealth(repo, provider)), mutedUntil })
  return `🔕 ${escapeHtml(PROVIDER_LABELS[provider])} silenciado hasta ${formatMadrid(mutedUntil)}`
}

async function currentHealth(repo: Repo, provider: ProviderId): Promise<StoredHealth> {
  const found = (await repo.getHealth()).find((h) => h.provider === provider)
  return found ?? { provider, consecutiveFailures: 0, brokenNotified: false }
}

async function unmute(env: Env, args: string[]): Promise<string> {
  const toolName = args.join(' ')
  if (toolName === '') return 'Uso: /activar &lt;herramienta&gt;'
  const provider = findProvider(toolName)
  if (provider === undefined) return unknownTool(toolName)
  const repo = new Repo(env.DB, env.CREDENTIALS_KEY)
  const { mutedUntil: _removed, ...health } = await currentHealth(repo, provider)
  await repo.putHealth(health)
  return `🔔 ${escapeHtml(PROVIDER_LABELS[provider])} activado`
}

const MAX_REFRESH_ERROR = 200

async function refresh(env: Env, now: Date, deps: CronDeps): Promise<void> {
  try {
    await refreshNow(env, now, deps)
  } catch (err) {
    console.error('refresh failed', err)
    const message = (err instanceof Error ? err.message : String(err)).slice(0, MAX_REFRESH_ERROR)
    await sendMessage(env, `No he podido actualizar: ${escapeHtml(message)}`, deps.fetch)
  }
}

async function refreshNow(env: Env, now: Date, deps: CronDeps): Promise<void> {
  const readings = await runCloudProviders(env, now, deps)
  if (!(await processReadings(env, readings, now, deps))) {
    await sendMessage(env, 'Ya hay una actualización en curso, prueba en un minuto', deps.fetch)
    return
  }
  const repo = new Repo(env.DB, env.CREDENTIALS_KEY)
  const quotas = await repo.getCurrentQuotas()
  const text = `${statusMessage(quotas, await repo.getHealth(), now, enabledProviders(env))}\n${localAgeNote(quotas, now)}`
  await sendMessage(env, text, deps.fetch)
}

interface TelegramMessage {
  chat?: { id?: unknown }
  text?: unknown
}

function parseCommand(text: string): { command: string; args: string[] } | undefined {
  const [head, ...args] = text.trim().split(/\s+/)
  if (!head?.startsWith('/')) return undefined
  const command = normalize(head.slice(1).replace(/@.*$/, ''))
  return { command, args }
}

export async function handleUpdate(
  env: Env,
  update: unknown,
  now: Date,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  deps: CronDeps = {},
): Promise<void> {
  const message = (update as { message?: TelegramMessage } | null | undefined)?.message
  if (typeof message !== 'object' || message === null) return
  if (String(message.chat?.id) !== env.TELEGRAM_CHAT_ID || typeof message.text !== 'string') return
  const parsed = parseCommand(message.text)
  if (parsed === undefined) return
  const { command, args } = parsed
  const reply = (text: string) => sendMessage(env, text, deps.fetch)
  const repo = new Repo(env.DB, env.CREDENTIALS_KEY)

  switch (command) {
    case 'estado': {
      const name = args.join(' ')
      const provider = name === '' ? undefined : findProvider(name)
      if (name !== '' && provider === undefined) {
        await reply(unknownTool(name))
        return
      }
      const quotas = (await repo.getCurrentQuotas()).filter((q) => provider === undefined || q.provider === provider)
      const health = (await repo.getHealth()).filter((h) => provider === undefined || h.provider === provider)
      await reply(statusMessage(quotas, health, now, provider === undefined ? enabledProviders(env) : [provider]))
      return
    }
    case 'prioridad':
      await reply(priorityMessage(await repo.getCurrentQuotas(), now))
      return
    case 'historial': {
      const name = args.join(' ')
      if (name === '') {
        await reply('Uso: /historial &lt;herramienta&gt;')
        return
      }
      const provider = findProvider(name)
      await reply(provider === undefined ? unknownTool(name) : await historyMessage(repo, provider))
      return
    }
    case 'actualizar':
      await reply('Actualizando…')
      ctx.waitUntil(refresh(env, now, deps))
      return
    case 'silenciar':
      await reply(await mute(env, args, now))
      return
    case 'activar':
      await reply(await unmute(env, args))
      return
    case 'ayuda':
    case 'start':
      await reply(HELP)
      return
    default:
      await reply('No conozco ese comando, prueba /ayuda')
  }
}
