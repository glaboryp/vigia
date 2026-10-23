import type { ErrorKind, ProviderId, ProviderReading, Source } from './types.js'
import { errorReading } from './providers/contract.js'

export class ProviderError extends Error {
  readonly kind: ErrorKind

  constructor(kind: ErrorKind, message: string) {
    super(message)
    this.name = 'ProviderError'
    this.kind = kind
  }
}

export function classifyHttp(status: number): ErrorKind | null {
  if (status === 401 || status === 403) return 'auth'
  if (status === 408 || status === 429 || status >= 500) return 'network'
  if (status >= 400) return 'unavailable'
  return null
}

export async function fetchJson(
  ctx: { fetch: typeof fetch },
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs)
  try {
    let response: Response
    let text: string
    try {
      response = await ctx.fetch(url, { ...init, signal: controller.signal })
      text = await response.text()
    } catch (err) {
      throw new ProviderError('network', err instanceof Error ? err.message : String(err))
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      if (response.status >= 200 && response.status < 300) {
        throw new ProviderError('parse', `non-JSON response body (HTTP ${response.status})`)
      }
      body = text
    }
    return { status: response.status, body }
  } finally {
    clearTimeout(timer)
  }
}

export function errorFromUnknown(provider: ProviderId, source: Source, err: unknown, now: Date): ProviderReading {
  if (err instanceof ProviderError) return errorReading(provider, source, err.kind, err.message, now)
  return errorReading(provider, source, 'unavailable', err instanceof Error ? err.message : String(err), now)
}
