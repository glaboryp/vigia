export type ProviderId =
  | 'copilot'
  | 'kilo'
  | 'qoder'
  | 'freebuff'
  | 'codex'
  | 'grok'
  | 'cursor'
  | 'antigravity'
  | 'mimo'
  | 'opencode'

export type Window = '5h' | 'daily' | 'weekly' | 'monthly'

export type Source = 'cloud' | 'local'

export interface Quota {
  provider: ProviderId
  quotaId: string
  name: string
  window: Window
  remainingFraction: number
  remaining?: number
  total?: number
  unit?: string
  resetsAt: string
}

export type ErrorKind = 'auth' | 'network' | 'parse' | 'unavailable'

export type ProviderReading =
  | { provider: ProviderId; ok: true; quotas: Quota[]; readAt: string; source: Source }
  | {
      provider: ProviderId
      ok: false
      error: { kind: ErrorKind; message: string }
      readAt: string
      source: Source
    }

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  copilot: 'GitHub Copilot',
  kilo: 'Kilo Code',
  qoder: 'Qoder CLI',
  freebuff: 'Freebuff',
  codex: 'Codex',
  grok: 'Grok',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  mimo: 'MiMo Code',
  opencode: 'opencode',
}
