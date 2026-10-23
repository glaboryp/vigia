import { fileURLToPath } from 'node:url'
import { errorReading, type ProviderId, type ProviderReading } from 'core'
import { readAntigravity } from './antigravity.js'
import { loadConfig, type AgentConfig } from './config.js'
import { IngestError, postIngest } from './ingest-client.js'
import { defaultStatePath } from './state.js'

export interface LocalReader {
  provider: ProviderId
  read(): Promise<ProviderReading>
}

export interface RunDeps {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  statePath?: string
  localReaders?: LocalReader[]
  log?: (message: string) => void
  logError?: (message: string) => void
}

export async function runOnce(cfg: AgentConfig, deps: RunDeps = {}): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m))
  const logError = deps.logError ?? ((m: string) => console.error(m))
  const statePath = deps.statePath ?? defaultStatePath()
  const readers: LocalReader[] = deps.localReaders ?? [
    { provider: 'antigravity', read: () => readAntigravity(undefined, undefined, { statePath }) },
  ]

  const readings: ProviderReading[] = []
  for (const reader of readers) {
    if (cfg.disabled.includes(reader.provider)) continue
    try {
      readings.push(await reader.read())
    } catch (err) {
      readings.push(
        errorReading(reader.provider, 'local', 'unavailable', err instanceof Error ? err.message : String(err), new Date()),
      )
    }
  }

  if (readings.length === 0) {
    log('Nada que enviar: no hay lectores locales activos')
    return 0
  }

  try {
    await postIngest(cfg, { readings }, deps.fetch, deps.sleep)
  } catch (err) {
    if (err instanceof IngestError && (err.network || err.status === 503)) {
      log(`No he podido enviar las lecturas (${err.message}); lo reintento en la próxima ejecución`)
      return 0
    }
    logError(`Error enviando las lecturas: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  log(`Enviadas ${readings.length} lecturas`)
  return 0
}

export async function main(): Promise<number> {
  let cfg: AgentConfig
  try {
    cfg = await loadConfig()
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  }
  return runOnce(cfg)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
    .catch((err) => {
      console.error(`Error inesperado: ${err instanceof Error ? err.message : String(err)}`)
      return 1
    })
    .then((code) => process.exit(code))
}
