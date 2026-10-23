import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface AgentState {
  cursorTokenHash?: string
  antigravityModelTurn?: { version: string }
}

export function defaultConfigPath(): string {
  return process.env.VIGIA_CONFIG ?? join(homedir(), '.config', 'vigia', 'agent.json')
}

export function defaultStatePath(): string {
  return join(dirname(defaultConfigPath()), 'state.json')
}

export async function readState(path: string = defaultStatePath()): Promise<AgentState> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as AgentState) : {}
  } catch {
    return {}
  }
}

export async function writeState(path: string, update: (state: AgentState) => AgentState): Promise<void> {
  const next = update(await readState(path))
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, path)
}
