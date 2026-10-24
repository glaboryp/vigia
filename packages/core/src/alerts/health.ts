import type { ErrorKind, ProviderId, ProviderReading, Source } from '../types.js'

export interface ProviderHealth {
  provider: ProviderId
  consecutiveFailures: number
  lastError?: { kind: ErrorKind; message: string }
  brokenNotified: boolean
  lastOkAt?: string
  mutedUntil?: string
}

export const FAILURES_BEFORE_ALERT = 3
export const STALE_LOCAL_MS = 48 * 3600_000

export function nextHealth(
  prev: ProviderHealth | undefined,
  reading: ProviderReading,
): { health: ProviderHealth; event?: 'broken' | 'recovered' } {
  const base = {
    provider: reading.provider,
    ...(prev?.lastOkAt !== undefined && { lastOkAt: prev.lastOkAt }),
    ...(prev?.mutedUntil !== undefined && { mutedUntil: prev.mutedUntil }),
  }

  if (reading.ok) {
    return {
      health: { ...base, consecutiveFailures: 0, brokenNotified: false, lastOkAt: reading.readAt },
      ...(prev?.brokenNotified && { event: 'recovered' as const }),
    }
  }

  const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1
  const alreadyNotified = prev?.brokenNotified ?? false
  const shouldNotify =
    !alreadyNotified && (reading.error.kind === 'auth' || consecutiveFailures >= FAILURES_BEFORE_ALERT)
  return {
    health: {
      ...base,
      consecutiveFailures,
      lastError: reading.error,
      brokenNotified: alreadyNotified || shouldNotify,
    },
    ...(shouldNotify && { event: 'broken' as const }),
  }
}

export function isStale(health: ProviderHealth, source: Source, now: Date): boolean {
  if (source !== 'local' || health.lastOkAt === undefined) return false
  return now.getTime() - Date.parse(health.lastOkAt) > STALE_LOCAL_MS
}
