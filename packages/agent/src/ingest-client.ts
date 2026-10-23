import type { ProviderId, ProviderReading } from 'core'
import type { AgentConfig } from './config.js'

export interface IngestPayload {
  readings: ProviderReading[]
  credentials?: { provider: ProviderId; value: string }[]
}

export class IngestError extends Error {
  readonly status: number | undefined
  readonly network: boolean

  constructor(message: string, opts: { status?: number; network?: boolean } = {}) {
    super(message)
    this.name = 'IngestError'
    this.status = opts.status
    this.network = opts.network ?? false
  }
}

const MAX_RETRIES = 3
const MAX_RETRY_AFTER_S = 60
const DEFAULT_RETRY_AFTER_S = 5

function retryDelayMs(header: string | null): number {
  const seconds = header === null ? NaN : Number(header)
  const value = Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_AFTER_S
  return Math.min(value, MAX_RETRY_AFTER_S) * 1000
}

export async function postIngest(
  cfg: AgentConfig,
  payload: IngestPayload,
  fetchFn: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  const base = cfg.workerUrl
  const url = new URL('ingest', base.endsWith('/') ? base : base + '/').href
  const body = JSON.stringify(payload)
  for (let attempt = 0; ; attempt++) {
    let response: Response
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.ingestToken}`, 'Content-Type': 'application/json' },
        body,
      })
    } catch (err) {
      throw new IngestError(`Sin conexión con el Worker: ${err instanceof Error ? err.message : String(err)}`, {
        network: true,
      })
    }
    if (response.status >= 200 && response.status < 300) return
    if (response.status === 503 && attempt < MAX_RETRIES) {
      await sleep(retryDelayMs(response.headers.get('retry-after')))
      continue
    }
    throw new IngestError(`El Worker respondió HTTP ${response.status}`, { status: response.status })
  }
}
