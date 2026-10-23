export type JsonRecord = Record<string, unknown>

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

export function pick(obj: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) if (obj[key] !== undefined && obj[key] !== null) return obj[key]
  return undefined
}

export function pickNumber(obj: JsonRecord, ...keys: string[]): number | undefined {
  return toNumber(pick(obj, ...keys))
}

export function toIso(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  let ms: number
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()))) {
    const n = Number(value)
    ms = n > 10_000_000_000 ? n : n * 1000
  } else if (typeof value === 'string') {
    ms = Date.parse(value)
  } else {
    return undefined
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

export function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value))
}
