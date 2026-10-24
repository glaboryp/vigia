import type { ErrorKind, ProviderId, ProviderReading, Quota, Source } from '../types.js'

export interface ProviderContext<C> {
  fetch: typeof fetch
  now: () => Date
  credential: C
}

export interface ProviderResult<C> {
  reading: ProviderReading
  rotatedCredential?: C
}

export interface Provider<C> {
  id: ProviderId
  source: Source
  parseCredential(raw: string): C
  serializeCredential(c: C): string
  read(ctx: ProviderContext<C>): Promise<ProviderResult<C>>
}

export function okReading(provider: ProviderId, source: Source, quotas: Quota[], now: Date): ProviderReading {
  return { provider, ok: true, quotas, readAt: now.toISOString(), source }
}

export function errorReading(
  provider: ProviderId,
  source: Source,
  kind: ErrorKind,
  message: string,
  now: Date,
): ProviderReading {
  return { provider, ok: false, error: { kind, message }, readAt: now.toISOString(), source }
}
