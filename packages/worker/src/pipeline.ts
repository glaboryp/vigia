import {
  brokenMessage,
  classifyTransition,
  dueUseOrLose,
  isRenewalAlert,
  nextHealth,
  periodKey,
  recoveredMessage,
  renewedMessage,
  useOrLoseKey,
  useOrLoseMessage,
  type ProviderHealth,
  type ProviderId,
  type ProviderReading,
} from 'core'
import { Repo, type StoredQuota } from './db.js'
import type { Env } from './env.js'
import { sendMessage } from './telegram.js'

export interface PipelineDeps {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<unknown>
}

const LEASE = 'evaluate'
const LEASE_TTL_MS = 60_000
const LEASE_RETRIES = 3
const LEASE_RETRY_MS = 2_000

const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const iso = (s: string) => new Date(s).toISOString()
const quotaKey = (provider: ProviderId, quotaId: string) => `${provider}\u0000${quotaId}`

export async function processReadings(
  env: Env,
  readings: ProviderReading[],
  now: Date,
  deps: PipelineDeps = {},
): Promise<void> {
  const repo = new Repo(env.DB, env.CREDENTIALS_KEY)
  const sleep = deps.sleep ?? defaultSleep
  let token = await repo.acquireLease(LEASE, LEASE_TTL_MS, now)
  for (let attempt = 1; token === null && attempt <= LEASE_RETRIES; attempt++) {
    await sleep(LEASE_RETRY_MS)
    token = await repo.acquireLease(LEASE, LEASE_TTL_MS, new Date(now.getTime() + attempt * LEASE_RETRY_MS))
  }
  if (token === null) return
  try {
    await new Evaluation(repo, now, (text) => sendMessage(env, text, deps.fetch)).run(readings)
  } finally {
    await repo.releaseLease(LEASE, token)
  }
}

class Evaluation {
  private health = new Map<ProviderId, ProviderHealth>()
  private current = new Map<string, StoredQuota>()

  constructor(
    private readonly repo: Repo,
    private readonly now: Date,
    private readonly send: (text: string) => Promise<boolean>,
  ) {}

  async run(readings: ProviderReading[]): Promise<void> {
    for (const h of await this.repo.getHealth()) this.health.set(h.provider, h)
    for (const q of await this.repo.getCurrentQuotas()) this.current.set(quotaKey(q.provider, q.quotaId), q)

    const ordered = [...readings].sort((a, b) => Date.parse(a.readAt) - Date.parse(b.readAt))
    for (const reading of ordered) {
      if (!(await this.repo.hasSnapshot(reading))) {
        await this.repo.insertSnapshot(reading)
        await this.updateHealth(reading)
      }
      if (reading.ok) await this.updateQuotas(reading)
    }
    await this.useOrLose()
  }

  private isMuted(provider: ProviderId): boolean {
    const until = this.health.get(provider)?.mutedUntil
    return until !== undefined && Date.parse(until) > this.now.getTime()
  }

  private async sendOnce(key: string, text: string): Promise<boolean> {
    if ((await this.repo.getSentKeys(key)).has(key)) return true
    if (!(await this.send(text))) return false
    await this.repo.markSent(key)
    return true
  }

  private async updateHealth(reading: ProviderReading): Promise<void> {
    const muted = this.isMuted(reading.provider)
    const { health, event } = nextHealth(this.health.get(reading.provider), reading)
    let stored = health
    if (event === 'broken') {
      const sent =
        !muted && (await this.sendOnce(`health:${reading.provider}:broken:${iso(reading.readAt)}`, brokenMessage(health)))
      stored = { ...health, brokenNotified: sent }
    } else if (event === 'recovered') {
      const sent =
        muted ||
        (await this.sendOnce(`health:${reading.provider}:recovered:${iso(reading.readAt)}`, recoveredMessage(reading.provider)))
      stored = { ...health, brokenNotified: !sent }
    }
    this.health.set(reading.provider, stored)
    await this.repo.putHealth(stored)
  }

  private async updateQuotas(reading: Extract<ProviderReading, { ok: true }>): Promise<void> {
    const muted = this.isMuted(reading.provider)
    for (const q of reading.quotas) {
      const key = quotaKey(q.provider, q.quotaId)
      const prev = this.current.get(key)
      if (prev && Date.parse(reading.readAt) < Date.parse(prev.readAt)) continue

      const transition = classifyTransition(prev, q)
      const next: StoredQuota = {
        ...q,
        periodResetAt: transition.kind === 'same-period' && prev ? prev.periodResetAt : q.resetsAt,
        readAt: reading.readAt,
        source: reading.source,
      }

      if (transition.kind === 'new-period' && transition.closedFraction !== null) {
        await this.repo.insertPeriodClose({
          provider: q.provider,
          quotaId: q.quotaId,
          window: q.window,
          periodResetAt: transition.closedPeriodResetAt,
          usedFraction: 1 - transition.closedFraction,
        })
      }

      if (!muted && isRenewalAlert(prev, q)) {
        const renewalKey = `renewed:${periodKey({ provider: q.provider, quotaId: q.quotaId, resetsAt: q.resetsAt })}`
        if (!(await this.sendOnce(renewalKey, renewedMessage(next)))) continue
      }

      await this.repo.upsertCurrentQuota(next)
      this.current.set(key, next)
    }
  }

  private async useOrLose(): Promise<void> {
    const quotas = (await this.repo.getCurrentQuotas()).filter((q) => !this.isMuted(q.provider))
    const due = dueUseOrLose(quotas, this.now, await this.repo.getSentKeys('useorlose:'))
    if (due.length === 0) return
    if (!(await this.send(useOrLoseMessage(due, this.now)))) return
    for (const q of due) await this.repo.markSent(useOrLoseKey(q))
  }
}
