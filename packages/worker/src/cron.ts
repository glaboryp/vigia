import {
  CLOUD_PROVIDERS,
  DEFAULT_SURPLUS_CONFIG,
  errorFromUnknown,
  errorReading,
  findSurplus,
  statusMessage,
  surplusMessage,
  type Provider,
  type ProviderId,
  type ProviderReading,
  type SurplusConfig,
} from 'core'
import { Repo } from './db.js'
import type { Env } from './env.js'
import { processReadings, type PipelineDeps } from './pipeline.js'
import { sendMessage } from './telegram.js'

export interface CronDeps extends PipelineDeps {
  only?: ProviderId[]
  providers?: Provider<any>[]
}

const PROVIDER_LEASE_TTL_MS = 120_000
const SNAPSHOT_RETENTION_MS = 90 * 86_400_000

interface Config {
  disabled: ProviderId[]
  surplus: Partial<SurplusConfig>
}

export function parseConfig(raw: string | undefined): Config {
  const config: Config = { disabled: [], surplus: {} }
  if (!raw) return config
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return config
    const { disabled, surplus } = parsed as { disabled?: unknown; surplus?: unknown }
    if (Array.isArray(disabled)) config.disabled = disabled.filter((d): d is ProviderId => typeof d === 'string')
    if (typeof surplus === 'object' && surplus !== null && !Array.isArray(surplus)) config.surplus = surplus
  } catch {
    return config
  }
  return config
}

export async function runCloudProviders(env: Env, now: Date, deps: CronDeps = {}): Promise<ProviderReading[]> {
  const repo = new Repo(env.DB, env.CREDENTIALS_KEY)
  const { disabled } = parseConfig(env.CONFIG_JSON)
  const fetchFn = deps.fetch ?? fetch
  const readings: ProviderReading[] = []
  for (const provider of deps.providers ?? CLOUD_PROVIDERS) {
    if (disabled.includes(provider.id)) continue
    if (deps.only && !deps.only.includes(provider.id)) continue
    const lease = `provider:${provider.id}`
    const token = await repo.acquireLease(lease, PROVIDER_LEASE_TTL_MS, deps.clock?.() ?? new Date())
    if (token === null) continue
    try {
      readings.push(await readProvider(repo, provider, fetchFn, now))
    } finally {
      await repo.releaseLease(lease, token)
    }
  }
  return readings
}

async function readProvider(
  repo: Repo,
  provider: Provider<any>,
  fetchFn: typeof fetch,
  now: Date,
): Promise<ProviderReading> {
  try {
    const raw = await repo.getCredential(provider.id)
    if (raw === null) return errorReading(provider.id, provider.source, 'auth', 'No hay credencial configurada', now)
    let credential: unknown
    try {
      credential = provider.parseCredential(raw)
    } catch {
      return errorReading(provider.id, provider.source, 'auth', 'Credencial inválida', now)
    }
    const { reading, rotatedCredential } = await provider.read({ fetch: fetchFn, now: () => now, credential })
    if (rotatedCredential !== undefined) await repo.putCredential(provider.id, provider.serializeCredential(rotatedCredential))
    return reading
  } catch (err) {
    return errorFromUnknown(provider.id, provider.source, err, now)
  }
}

const madridParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  hourCycle: 'h23',
})

function madrid(now: Date) {
  const p = Object.fromEntries(madridParts.formatToParts(now).map((x) => [x.type, x.value]))
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    monday: p.weekday === 'Mon',
    digestDue: Number(p.hour) >= 9,
  }
}

function isoWeek(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day))
  const weekday = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - weekday)
  const week = Math.ceil(((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export async function runScheduled(env: Env, now: Date, deps: CronDeps = {}): Promise<void> {
  const readings = await runCloudProviders(env, now, deps)
  if (!(await processReadings(env, readings, now, deps))) {
    console.warn('evaluation busy, skipping cron run')
    return
  }
  const repo = new Repo(env.DB, env.CREDENTIALS_KEY)
  const local = madrid(now)

  if (local.digestDue && local.monday) {
    const key = `weekly:${isoWeek(local.year, local.month, local.day)}`
    if (!(await repo.getSentKeys(key)).has(key)) {
      const text = statusMessage(await repo.getCurrentQuotas(), await repo.getHealth(), now)
      if (await sendMessage(env, text, deps.fetch)) await repo.markSent(key)
    }
  }

  if (local.digestDue && local.day === 1) {
    const key = `surplus:${local.year}-${String(local.month).padStart(2, '0')}`
    if (!(await repo.getSentKeys(key)).has(key)) {
      const config = { ...DEFAULT_SURPLUS_CONFIG, ...parseConfig(env.CONFIG_JSON).surplus }
      const items = findSurplus(await repo.getPeriodCloses(), config)
      if (items.length === 0 || (await sendMessage(env, surplusMessage(items), deps.fetch))) await repo.markSent(key)
    }
  }

  await repo.purgeSnapshotsBefore(new Date(now.getTime() - SNAPSHOT_RETENTION_MS).toISOString())
}
