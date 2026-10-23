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

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function base64UrlDecode(input: string): Uint8Array {
  const clean = input.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of clean) {
    const value = B64URL.indexOf(ch)
    if (value < 0) throw new Error('Invalid base64url input')
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

export function decodeJwtPayload(token: string | undefined): JsonRecord | undefined {
  const part = token?.split('.')[1]
  if (!part) return undefined
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(part)))
    return isRecord(payload) ? payload : undefined
  } catch {
    return undefined
  }
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}
