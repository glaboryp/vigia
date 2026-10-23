import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  LOCAL_HTTP_PROVIDERS,
  ProviderError,
  cursorProvider,
  errorFromUnknown,
  errorReading,
  type Provider,
  type ProviderId,
  type ProviderReading,
} from 'core'
import { readAntigravity, type Runner } from './antigravity.js'
import { BRAVE_COOKIE_HOSTS, getBraveCookieHeader, keyringPassword } from './brave-cookies.js'
import { loadConfig, type AgentConfig } from './config.js'
import { IngestError, postIngest } from './ingest-client.js'
import { readCursorToken } from './cursor-token.js'
import { defaultStatePath, readState, writeState } from './state.js'

export interface LocalReader {
  provider: ProviderId
  read(): Promise<ProviderReading>
}

export interface RunDeps {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  statePath?: string
  readCursorToken?: () => Promise<string | null>
  localReaders?: LocalReader[]
  localHttpProviders?: Provider<any>[]
  braveProfileDir?: string
  secretToolRun?: Runner
  braveCookieHeader?: (host: string) => Promise<string | null>
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

  const password = keyringPassword(deps.secretToolRun)
  const cookieFor =
    deps.braveCookieHeader ??
    ((host: string) => getBraveCookieHeader(host, { password, profileDir: deps.braveProfileDir }))
  for (const provider of deps.localHttpProviders ?? LOCAL_HTTP_PROVIDERS) {
    if (cfg.disabled.includes(provider.id)) continue
    const host = BRAVE_COOKIE_HOSTS[provider.id]
    if (!host) continue
    const now = new Date()
    try {
      const cookie = await cookieFor(host)
      if (cookie === null) throw new ProviderError('auth', `Inicia sesión en ${host} con Brave`)
      const result = await provider.read({ fetch: deps.fetch ?? fetch, now: () => new Date(), credential: { cookie } })
      readings.push(result.reading)
    } catch (err) {
      readings.push(errorFromUnknown(provider.id, 'local', err, now))
    }
  }

  const credentials: { provider: ProviderId; value: string }[] = []
  let cursorHash: string | undefined
  if (!cfg.disabled.includes('cursor')) {
    try {
      const token = await (deps.readCursorToken ?? readCursorToken)()
      if (token) {
        const hash = createHash('sha256').update(token).digest('hex')
        if (hash !== (await readState(statePath)).cursorTokenHash) {
          credentials.push({ provider: 'cursor', value: cursorProvider.serializeCredential({ accessToken: token }) })
          cursorHash = hash
        }
      }
    } catch (err) {
      logError(`No puedo leer el token de Cursor: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (readings.length === 0 && credentials.length === 0) {
    log('Nada que enviar: no hay lectores locales activos')
    return 0
  }

  try {
    await postIngest(cfg, credentials.length > 0 ? { readings, credentials } : { readings }, deps.fetch, deps.sleep)
  } catch (err) {
    if (err instanceof IngestError && (err.network || err.status === 503)) {
      log(`No he podido enviar las lecturas (${err.message}); lo reintento en la próxima ejecución`)
      return 0
    }
    logError(`Error enviando las lecturas: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  if (cursorHash !== undefined) {
    const hash = cursorHash
    try {
      await writeState(statePath, (s) => ({ ...s, cursorTokenHash: hash }))
      log('Token de Cursor sincronizado')
    } catch (err) {
      logError(`No he podido guardar el estado del token de Cursor: ${err instanceof Error ? err.message : String(err)}`)
    }
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
