import { readFile, stat } from 'node:fs/promises'
import { PROVIDER_LABELS, type ProviderId } from 'core'
import { defaultConfigPath } from './state.js'

export interface AgentConfig {
  workerUrl: string
  ingestToken: string
  disabled: ProviderId[]
}

export async function loadConfig(path: string = defaultConfigPath()): Promise<AgentConfig> {
  let mode: number
  try {
    mode = (await stat(path)).mode
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `No existe la configuración del agente en ${path}. Créala con {"workerUrl":"https://…","ingestToken":"…","disabled":[]} y ejecuta chmod 600 sobre el fichero.`,
      )
    }
    throw err
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(`La configuración ${path} es accesible por otros usuarios; ejecuta chmod 600 ${path}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error(`La configuración ${path} no es un JSON válido`)
  }
  if (raw === null || typeof raw !== 'object') throw new Error(`La configuración ${path} no es un objeto JSON`)
  const { workerUrl, ingestToken, disabled } = raw as Record<string, unknown>
  if (typeof workerUrl !== 'string' || workerUrl === '') throw new Error(`Falta "workerUrl" en ${path}`)
  if (typeof ingestToken !== 'string' || ingestToken === '') throw new Error(`Falta "ingestToken" en ${path}`)
  const placeholder = (value: string) => (/[<>]/.test(value) ? (value.match(/<[^>]*>/)?.[0] ?? '<…>') : undefined)
  const urlPlaceholder = placeholder(workerUrl)
  if (urlPlaceholder) {
    throw new Error(
      `Edita ~/.config/vigia/agent.json: sustituye ${urlPlaceholder} por el subdominio real de tu Worker (lo ves en el panel de Cloudflare → Workers)`,
    )
  }
  const tokenPlaceholder = placeholder(ingestToken)
  if (tokenPlaceholder) {
    throw new Error(
      `Edita ~/.config/vigia/agent.json: sustituye ${tokenPlaceholder} por el INGEST_TOKEN real que subiste al Worker`,
    )
  }
  let url: URL
  try {
    url = new URL(workerUrl)
  } catch {
    throw new Error(`"workerUrl" no es una URL válida en ${path}`)
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`"workerUrl" debe usar https (http solo para localhost) en ${path}`)
  }
  if (disabled !== undefined) {
    if (!Array.isArray(disabled)) throw new Error(`"disabled" debe ser una lista de proveedores en ${path}`)
    const unknown = disabled.filter((d) => typeof d !== 'string' || !Object.hasOwn(PROVIDER_LABELS, d))
    if (unknown.length > 0) throw new Error(`"disabled" contiene proveedores desconocidos en ${path}: ${unknown.join(', ')}`)
  }
  return { workerUrl, ingestToken, disabled: (disabled ?? []) as ProviderId[] }
}
