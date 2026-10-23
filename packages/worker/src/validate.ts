import { PROVIDER_LABELS, type ErrorKind, type ProviderId, type ProviderReading, type Quota, type Source, type Window } from 'core'

export interface IngestBody {
  readings: ProviderReading[]
  credentials: { provider: ProviderId; value: string }[]
}

class Invalid extends Error {}

const WINDOWS: readonly Window[] = ['5h', 'daily', 'weekly', 'monthly']
const SOURCES: readonly Source[] = ['cloud', 'local']
const ERROR_KINDS: readonly ErrorKind[] = ['auth', 'network', 'parse', 'unavailable']
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

type Obj = Record<string, unknown>

function check(cond: boolean, what: string): asserts cond {
  if (!cond) throw new Invalid(what)
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): v is T => typeof v === 'string' && allowed.includes(v as T)
const isIso = (v: unknown): v is string => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v))
const isProvider = (v: unknown): v is ProviderId => typeof v === 'string' && Object.hasOwn(PROVIDER_LABELS, v)
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function optional<T>(o: Obj, key: string, guard: (v: unknown) => v is T): { [k: string]: T } {
  if (o[key] === undefined) return {}
  check(guard(o[key]), key)
  return { [key]: o[key] as T }
}

function quota(v: unknown, provider: ProviderId): Quota {
  check(isObj(v), 'quota')
  check(v.provider === provider, 'quota.provider')
  check(typeof v.quotaId === 'string' && v.quotaId.length > 0, 'quota.quotaId')
  check(typeof v.name === 'string', 'quota.name')
  check(oneOf(v.window, WINDOWS), 'quota.window')
  check(isFiniteNumber(v.remainingFraction) && v.remainingFraction >= 0 && v.remainingFraction <= 1, 'quota.remainingFraction')
  check(isIso(v.resetsAt), 'quota.resetsAt')
  return {
    provider,
    quotaId: v.quotaId,
    name: v.name,
    window: v.window,
    remainingFraction: v.remainingFraction,
    ...optional(v, 'remaining', isFiniteNumber),
    ...optional(v, 'total', isFiniteNumber),
    ...optional(v, 'unit', (u): u is string => typeof u === 'string'),
    resetsAt: v.resetsAt,
  }
}

function reading(v: unknown): ProviderReading {
  check(isObj(v), 'reading')
  check(isProvider(v.provider), 'reading.provider')
  check(oneOf(v.source, SOURCES), 'reading.source')
  check(isIso(v.readAt), 'reading.readAt')
  const base = { provider: v.provider, readAt: v.readAt, source: v.source }
  if (v.ok === true) {
    check(Array.isArray(v.quotas), 'reading.quotas')
    const provider = v.provider
    return { ...base, ok: true, quotas: v.quotas.map((q) => quota(q, provider)) }
  }
  check(v.ok === false, 'reading.ok')
  check(isObj(v.error) && oneOf(v.error.kind, ERROR_KINDS) && typeof v.error.message === 'string', 'reading.error')
  return { ...base, ok: false, error: { kind: v.error.kind, message: v.error.message } }
}

function credential(v: unknown): { provider: ProviderId; value: string } {
  check(isObj(v) && isProvider(v.provider) && typeof v.value === 'string' && v.value.length > 0, 'credential')
  return { provider: v.provider, value: v.value }
}

export function parseIngestBody(v: unknown): IngestBody | null {
  try {
    check(isObj(v) && Array.isArray(v.readings), 'readings')
    const credentials = v.credentials === undefined ? [] : v.credentials
    check(Array.isArray(credentials), 'credentials')
    return { readings: v.readings.map(reading), credentials: credentials.map(credential) }
  } catch (e) {
    if (e instanceof Invalid) return null
    throw e
  }
}
