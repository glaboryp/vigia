import type {
  PeriodClose,
  ErrorKind,
  ProviderHealth,
  ProviderId,
  ProviderReading,
  Source,
  TrackedQuota,
  Window,
} from 'core'
import { decrypt, encrypt } from './crypto.js'

export type StoredQuota = TrackedQuota & { source: Source }

interface QuotaRow {
  provider: ProviderId
  quota_id: string
  name: string
  window: Window
  remaining_fraction: number
  remaining: number | null
  total: number | null
  unit: string | null
  resets_at: string
  period_reset_at: string
  read_at: string
  source: Source
}

interface CloseRow {
  provider: ProviderId
  quota_id: string
  window: Window
  period_reset_at: string
  used_fraction: number
}

interface HealthRow {
  provider: ProviderId
  consecutive_failures: number
  last_error_kind: ErrorKind | null
  last_error_message: string | null
  broken_notified: number
  last_ok_at: string | null
  muted_until: string | null
}

const toQuota = (r: QuotaRow): StoredQuota => ({
  provider: r.provider,
  quotaId: r.quota_id,
  name: r.name,
  window: r.window,
  remainingFraction: r.remaining_fraction,
  ...(r.remaining !== null && { remaining: r.remaining }),
  ...(r.total !== null && { total: r.total }),
  ...(r.unit !== null && { unit: r.unit }),
  resetsAt: r.resets_at,
  periodResetAt: r.period_reset_at,
  readAt: r.read_at,
  source: r.source,
})

const toClose = (r: CloseRow): PeriodClose => ({
  provider: r.provider,
  quotaId: r.quota_id,
  window: r.window,
  periodResetAt: r.period_reset_at,
  usedFraction: r.used_fraction,
})

const toHealth = (r: HealthRow): ProviderHealth => ({
  provider: r.provider,
  consecutiveFailures: r.consecutive_failures,
  ...(r.last_error_kind !== null && { lastError: { kind: r.last_error_kind, message: r.last_error_message ?? '' } }),
  brokenNotified: r.broken_notified === 1,
  ...(r.last_ok_at !== null && { lastOkAt: r.last_ok_at }),
  ...(r.muted_until !== null && { mutedUntil: r.muted_until }),
})

const iso = (s: string): string => new Date(s).toISOString()

export class Repo {
  constructor(
    private readonly db: D1Database,
    private readonly credentialsKey?: string,
  ) {}

  async insertSnapshot(r: ProviderReading): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO snapshots (provider, source, ok, error_kind, error_message, quotas_json, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        r.provider,
        r.source,
        r.ok ? 1 : 0,
        r.ok ? null : r.error.kind,
        r.ok ? null : r.error.message,
        r.ok ? JSON.stringify(r.quotas) : null,
        iso(r.readAt),
      )
      .run()
  }

  async getCurrentQuotas(): Promise<StoredQuota[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM current_quotas ORDER BY provider, quota_id')
      .all<QuotaRow>()
    return results.map(toQuota)
  }

  async upsertCurrentQuota(q: StoredQuota): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO current_quotas
           (provider, quota_id, name, window, remaining_fraction, remaining, total, unit,
            resets_at, period_reset_at, read_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider, quota_id) DO UPDATE SET
           name = excluded.name,
           window = excluded.window,
           remaining_fraction = excluded.remaining_fraction,
           remaining = excluded.remaining,
           total = excluded.total,
           unit = excluded.unit,
           resets_at = excluded.resets_at,
           period_reset_at = excluded.period_reset_at,
           read_at = excluded.read_at,
           source = excluded.source`,
      )
      .bind(
        q.provider,
        q.quotaId,
        q.name,
        q.window,
        q.remainingFraction,
        q.remaining ?? null,
        q.total ?? null,
        q.unit ?? null,
        iso(q.resetsAt),
        iso(q.periodResetAt),
        iso(q.readAt),
        q.source,
      )
      .run()
  }

  async insertPeriodClose(c: PeriodClose): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO period_closes (provider, quota_id, window, period_reset_at, used_fraction)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (provider, quota_id, period_reset_at) DO NOTHING`,
      )
      .bind(c.provider, c.quotaId, c.window, iso(c.periodResetAt), c.usedFraction)
      .run()
  }

  async getPeriodCloses(provider?: ProviderId): Promise<PeriodClose[]> {
    const stmt =
      provider === undefined
        ? this.db.prepare('SELECT * FROM period_closes ORDER BY provider, quota_id, period_reset_at')
        : this.db
            .prepare('SELECT * FROM period_closes WHERE provider = ? ORDER BY quota_id, period_reset_at')
            .bind(provider)
    const { results } = await stmt.all<CloseRow>()
    return results.map(toClose)
  }

  async getHealth(): Promise<ProviderHealth[]> {
    const { results } = await this.db.prepare('SELECT * FROM provider_health ORDER BY provider').all<HealthRow>()
    return results.map(toHealth)
  }

  async putHealth(h: ProviderHealth): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO provider_health
           (provider, consecutive_failures, last_error_kind, last_error_message, broken_notified, last_ok_at, muted_until)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider) DO UPDATE SET
           consecutive_failures = excluded.consecutive_failures,
           last_error_kind = excluded.last_error_kind,
           last_error_message = excluded.last_error_message,
           broken_notified = excluded.broken_notified,
           last_ok_at = excluded.last_ok_at,
           muted_until = excluded.muted_until`,
      )
      .bind(
        h.provider,
        h.consecutiveFailures,
        h.lastError?.kind ?? null,
        h.lastError?.message ?? null,
        h.brokenNotified ? 1 : 0,
        h.lastOkAt === undefined ? null : iso(h.lastOkAt),
        h.mutedUntil === undefined ? null : iso(h.mutedUntil),
      )
      .run()
  }

  async getSentKeys(prefix?: string): Promise<Set<string>> {
    const stmt =
      prefix === undefined
        ? this.db.prepare('SELECT key FROM sent_alerts')
        : this.db.prepare('SELECT key FROM sent_alerts WHERE substr(key, 1, ?) = ?').bind(prefix.length, prefix)
    const { results } = await stmt.all<{ key: string }>()
    return new Set(results.map((r) => r.key))
  }

  async markSent(key: string): Promise<boolean> {
    const res = await this.db
      .prepare('INSERT INTO sent_alerts (key) VALUES (?) ON CONFLICT (key) DO NOTHING')
      .bind(key)
      .run()
    return res.meta.changes > 0
  }

  async getCredential(p: ProviderId): Promise<string | null> {
    const row = await this.db.prepare('SELECT value FROM credentials WHERE provider = ?').bind(p).first<{ value: string }>()
    return row ? decrypt(this.requireKey(), row.value, p) : null
  }

  async putCredential(p: ProviderId, plaintext: string): Promise<void> {
    const value = await encrypt(this.requireKey(), plaintext, p)
    await this.db
      .prepare(
        `INSERT INTO credentials (provider, value) VALUES (?, ?)
         ON CONFLICT (provider) DO UPDATE SET
           value = excluded.value,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .bind(p, value)
      .run()
  }

  async acquireLease(name: string, ttlMs: number, now: Date): Promise<string | null> {
    const nowMs = now.getTime()
    const token = crypto.randomUUID()
    const res = await this.db
      .prepare(
        `INSERT INTO leases (name, holder, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
         WHERE leases.expires_at < ?`,
      )
      .bind(name, token, nowMs + ttlMs, nowMs)
      .run()
    return res.meta.changes > 0 ? token : null
  }

  async releaseLease(name: string, token: string): Promise<void> {
    await this.db.prepare('DELETE FROM leases WHERE name = ? AND holder = ?').bind(name, token).run()
  }

  async purgeSnapshotsBefore(before: string): Promise<void> {
    await this.db.prepare('DELETE FROM snapshots WHERE read_at < ?').bind(iso(before)).run()
  }

  private requireKey(): string {
    if (this.credentialsKey === undefined) throw new Error('credentials key not configured')
    return this.credentialsKey
  }
}
