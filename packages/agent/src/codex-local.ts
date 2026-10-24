import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ProviderError, codexProvider, errorFromUnknown, type ProviderReading } from 'core'

export function defaultCodexAuthPath(): string {
  return join(homedir(), '.vigia', 'codex', 'auth.json')
}

export async function readCodexLocal(
  deps: { path?: string; fetch?: typeof fetch; now?: () => Date } = {},
): Promise<ProviderReading> {
  const path = deps.path ?? defaultCodexAuthPath()
  const now = deps.now ?? (() => new Date())
  try {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      throw new ProviderError('auth', 'Falta el login de Codex: pnpm --filter agent run login codex')
    }
    let credential
    try {
      credential = codexProvider.parseCredential(raw)
    } catch {
      throw new ProviderError('auth', 'El login de Codex no es válido: pnpm --filter agent run login codex')
    }
    const { reading, rotatedCredential } = await codexProvider.read({ fetch: deps.fetch ?? fetch, now, credential })
    if (rotatedCredential !== undefined) {
      const tmp = `${path}.${process.pid}.tmp`
      await writeFile(tmp, codexProvider.serializeCredential(rotatedCredential) + '\n', { mode: 0o600 })
      await chmod(tmp, 0o600)
      await rename(tmp, path)
    }
    return { ...reading, source: 'local' }
  } catch (err) {
    return errorFromUnknown('codex', 'local', err, now())
  }
}
