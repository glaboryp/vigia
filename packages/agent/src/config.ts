import { readFile, stat } from 'node:fs/promises'
import type { ProviderId } from 'core'
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
  if (disabled !== undefined && (!Array.isArray(disabled) || disabled.some((d) => typeof d !== 'string'))) {
    throw new Error(`"disabled" debe ser una lista de proveedores en ${path}`)
  }
  return { workerUrl, ingestToken, disabled: (disabled ?? []) as ProviderId[] }
}
