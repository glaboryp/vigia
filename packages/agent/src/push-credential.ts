import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { CLOUD_PROVIDERS, LOCAL_HTTP_PROVIDERS, PROVIDER_LABELS } from 'core'
import { loadConfig, type AgentConfig } from './config.js'
import { IngestError, postIngest } from './ingest-client.js'

export async function pushCredential(cfg: AgentConfig, id: string, raw: string, fetchFn?: typeof fetch): Promise<void> {
  const provider = CLOUD_PROVIDERS.find((p) => p.id === id)
  if (!provider) {
    if ([...LOCAL_HTTP_PROVIDERS, { id: 'antigravity' }].some((p) => p.id === id)) {
      throw new Error(`${PROVIDER_LABELS[id as keyof typeof PROVIDER_LABELS]} se lee en local: su credencial no se sube`)
    }
    throw new Error(`Proveedor desconocido: ${id}. Disponibles: ${CLOUD_PROVIDERS.map((p) => p.id).join(', ')}`)
  }
  let value: string
  try {
    value = provider.serializeCredential(provider.parseCredential(raw.trim()))
  } catch {
    throw new Error(`El fichero no contiene una credencial válida para ${id}`)
  }
  await postIngest(cfg, { readings: [], credentials: [{ provider: provider.id, value }] }, fetchFn)
}

export interface MainDeps {
  fetch?: typeof fetch
  log?: (message: string) => void
  logError?: (message: string) => void
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m))
  const logError = deps.logError ?? ((m: string) => console.error(m))
  const [id, file] = argv
  if (!id || !file) {
    logError('Uso: push-credential <proveedor> <fichero>')
    return 1
  }
  try {
    const cfg = await loadConfig()
    await pushCredential(cfg, id, await readFile(file, 'utf8'), deps.fetch)
  } catch (err) {
    if (err instanceof IngestError) {
      logError(`No he podido subir la credencial: ${err.message}`)
    } else {
      logError(err instanceof Error ? err.message : String(err))
    }
    return 1
  }
  log(`Credencial de ${id} subida`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2))
    .catch(() => {
      console.error('Error inesperado')
      return 1
    })
    .then((code) => process.exit(code))
}
