import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ProviderError, type ProviderId } from 'core'
import { runProcess, type Runner } from './antigravity.js'
import { exists, withSqliteCopy } from './sqlite-copy.js'

export const BRAVE_COOKIE_HOSTS: Partial<Record<ProviderId, string>> = {
  mimo: 'platform.xiaomimimo.com',
  opencode: 'opencode.ai',
}

export interface BraveCookieDeps {
  dbPath?: string
  profileDir?: string
  run?: Runner
  password?: () => Promise<string | null>
  now?: () => Date
}

const SECRET_TOOL_TIMEOUT_MS = 5_000
const HASH_PREFIX_VERSION = 24
const WINDOWS_EPOCH_OFFSET_MS = 11_644_473_600_000

export function defaultBraveProfileDir(): string {
  return join(homedir(), '.config', 'BraveSoftware', 'Brave-Browser', 'Default')
}

async function resolveCookiesPath(deps: BraveCookieDeps): Promise<string> {
  if (deps.dbPath) return deps.dbPath
  const dir = deps.profileDir ?? defaultBraveProfileDir()
  for (const candidate of [join(dir, 'Network', 'Cookies'), join(dir, 'Cookies')]) {
    if (await exists(candidate)) return candidate
  }
  throw new ProviderError('auth', 'No encuentro el perfil de Brave')
}

const defaultSecretTool: Runner = (cmd, args, env) => runProcess(cmd, args, env, { timeoutMs: SECRET_TOOL_TIMEOUT_MS })

export function keyringPassword(run: Runner = defaultSecretTool): () => Promise<string | null> {
  let cached: Promise<string | null> | undefined
  return () => {
    cached ??= (async () => {
      let result
      try {
        result = await run('secret-tool', ['lookup', 'application', 'brave'], process.env)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new ProviderError('auth', 'Instala libsecret-tools (sudo apt install libsecret-tools) para leer las cookies de Brave')
        }
        return null
      }
      const password = result.stdout.replace(/\r?\n$/, '')
      return result.code === 0 && password !== '' ? password : null
    })()
    return cached
  }
}

function candidateHosts(host: string): string[] {
  const labels = host.split('.')
  const hosts: string[] = []
  hosts.push(host, `.${host}`)
  for (let i = 1; i <= labels.length - 2; i++) hosts.push(`.${labels.slice(i).join('.')}`)
  return hosts
}

function decrypt(encrypted: Uint8Array, password: string, dropHash: boolean): string {
  const key = pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1')
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  const plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()])
  const text = new TextDecoder('utf-8', { fatal: true }).decode(plain.subarray(dropHash ? 32 : 0))
  if (/[\x00-\x1f\x7f]/.test(text)) throw new Error('not printable')
  return text
}

interface CookieRow {
  host_key: string
  name: string
  value: string
  encrypted_value: Uint8Array
  expires_utc: number | bigint
}

export async function getBraveCookieHeader(host: string, deps: BraveCookieDeps = {}): Promise<string | null> {
  const dbPath = await resolveCookiesPath(deps)
  const nowMs = (deps.now ?? (() => new Date()))().getTime()
  const getPassword = deps.password ?? keyringPassword(deps.run)
  const hosts = candidateHosts(host)

  const { version, rows } = await withSqliteCopy(dbPath, 'vigia-brave-', (db) => {
    try {
      return readRows(db)
    } catch {
      throw new ProviderError('parse', 'No puedo leer la base de cookies de Brave')
    }
  })

  function readRows(db: DatabaseSync) {
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: unknown } | undefined
    const stmt = db.prepare(
      `SELECT host_key, name, value, encrypted_value, expires_utc FROM cookies WHERE host_key IN (${hosts.map(() => '?').join(',')}) ORDER BY length(host_key) DESC`,
    )
    stmt.setReadBigInts(true)
    const found = stmt.all(...hosts) as unknown as CookieRow[]
    return { version: Number(meta?.value ?? 0), rows: found }
  }

  let candidates = 0
  let decrypted = 0
  const byName = new Map<string, string>()
  for (const row of rows) {
    const expires = Number(row.expires_utc)
    if (expires > 0 && expires / 1000 - WINDOWS_EPOCH_OFFSET_MS <= nowMs) continue
    if (byName.has(row.name)) continue
    let value = row.value
    if (value === '') {
      const enc = Buffer.from(row.encrypted_value)
      if (enc.length === 0) continue
      const prefix = enc.subarray(0, 3).toString('latin1')
      let password: string | null
      if (prefix === 'v10') password = 'peanuts'
      else if (prefix === 'v11') {
        password = await getPassword()
        if (password === null) throw new ProviderError('auth', 'No puedo acceder al llavero de GNOME')
      } else continue
      candidates++
      try {
        value = decrypt(enc, password, version >= HASH_PREFIX_VERSION)
      } catch {
        continue
      }
      decrypted++
    }
    byName.set(row.name, value)
  }
  if (candidates > 0 && decrypted === 0) throw new ProviderError('parse', 'No puedo descifrar las cookies de Brave')
  if (byName.size === 0) return null
  return [...byName].map(([k, v]) => `${k}=${v}`).join('; ')
}
