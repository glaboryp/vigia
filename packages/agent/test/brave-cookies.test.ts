import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBraveCookieHeader, keyringPassword } from '../src/brave-cookies.ts'
import type { Runner } from '../src/antigravity.ts'

const NOW = new Date('2026-10-23T10:00:00Z')
const PASSWORD = 'keyring-secret'

function encrypt(value: string, host: string, opts: { prefix: 'v10' | 'v11'; password: string; hashed: boolean }): Buffer {
  const key = pbkdf2Sync(opts.password, 'saltysalt', 1, 16, 'sha1')
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  const plain = Buffer.concat([opts.hashed ? createHash('sha256').update(host).digest() : Buffer.alloc(0), Buffer.from(value)])
  return Buffer.concat([Buffer.from(opts.prefix), cipher.update(plain), cipher.final()])
}

interface Row {
  host: string
  name: string
  enc?: Buffer
  value?: string
  expires?: number
}

let dir: string
let dbPath: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vigia-brave-'))
  dbPath = join(dir, 'Cookies')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

function makeDb(version: number, rows: Row[]) {
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE meta (key TEXT UNIQUE NOT NULL, value TEXT)')
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER)')
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('version', String(version))
  const ins = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?)')
  for (const r of rows) ins.run(r.host, r.name, r.value ?? '', r.enc ?? Buffer.alloc(0), r.expires ?? 0)
  db.close()
}

const secretTool = (stdout: string, code = 0): Runner => async () => ({ code, stdout, stderr: '' })
const micros = (d: Date) => (d.getTime() + 11644473600000) * 1000

describe('getBraveCookieHeader', () => {
  it('decrypts v11 cookies and drops the 32-byte hash prefix for meta.version >= 24', async () => {
    const enc = (v: string, h: string) => encrypt(v, h, { prefix: 'v11', password: PASSWORD, hashed: true })
    makeDb(24, [
      { host: 'platform.xiaomimimo.com', name: 'a', enc: enc('one', 'platform.xiaomimimo.com') },
      { host: '.xiaomimimo.com', name: 'b', enc: enc('two', '.xiaomimimo.com') },
      { host: 'other.com', name: 'c', enc: enc('no', 'other.com') },
    ])
    const header = await getBraveCookieHeader('platform.xiaomimimo.com', { dbPath, run: secretTool(PASSWORD + '\n'), now: () => NOW })
    expect(header).toBe('a=one; b=two')
  })

  it('decrypts v11 cookies without prefix for meta.version < 24', async () => {
    makeDb(23, [{ host: '.opencode.ai', name: 'auth', enc: encrypt('tok', '.opencode.ai', { prefix: 'v11', password: PASSWORD, hashed: false }) }])
    const header = await getBraveCookieHeader('opencode.ai', { dbPath, run: secretTool(PASSWORD), now: () => NOW })
    expect(header).toBe('auth=tok')
  })

  it('uses peanuts for v10 without asking the keyring', async () => {
    makeDb(24, [{ host: 'opencode.ai', name: 'k', enc: encrypt('v', 'opencode.ai', { prefix: 'v10', password: 'peanuts', hashed: true }) }])
    const run = vi.fn(secretTool('', 1))
    expect(await getBraveCookieHeader('opencode.ai', { dbPath, run, now: () => NOW })).toBe('k=v')
    expect(run).not.toHaveBeenCalled()
  })

  it('prefers plaintext value and skips expired cookies but keeps session ones', async () => {
    makeDb(24, [
      { host: 'opencode.ai', name: 'plain', value: 'p' },
      { host: 'opencode.ai', name: 'old', value: 'x', expires: micros(new Date('2026-01-01T00:00:00Z')) },
      { host: 'opencode.ai', name: 'live', value: 'y', expires: micros(new Date('2027-01-01T00:00:00Z')) },
    ])
    const run = vi.fn(secretTool('', 1))
    expect(await getBraveCookieHeader('opencode.ai', { dbPath, run, now: () => NOW })).toBe('plain=p; live=y')
  })

  it('returns null when there are no cookies for the host', async () => {
    makeDb(24, [{ host: 'other.com', name: 'a', value: 'b' }])
    expect(await getBraveCookieHeader('opencode.ai', { dbPath, run: secretTool(PASSWORD), now: () => NOW })).toBeNull()
  })

  it('returns null when the Cookies database does not exist', async () => {
    expect(await getBraveCookieHeader('opencode.ai', { dbPath: join(dir, 'missing'), run: secretTool(PASSWORD) })).toBeNull()
  })

  it('fails with auth when secret-tool is not installed', async () => {
    makeDb(24, [{ host: 'opencode.ai', name: 'a', enc: encrypt('v', 'opencode.ai', { prefix: 'v11', password: PASSWORD, hashed: true }) }])
    const run: Runner = async () => {
      throw Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' })
    }
    await expect(getBraveCookieHeader('opencode.ai', { dbPath, run })).rejects.toMatchObject({
      kind: 'auth',
      message: 'Instala libsecret-tools (sudo apt install libsecret-tools) para leer las cookies de Brave',
    })
  })

  it('fails with auth when the keyring is locked or has no item', async () => {
    makeDb(24, [{ host: 'opencode.ai', name: 'a', enc: encrypt('v', 'opencode.ai', { prefix: 'v11', password: PASSWORD, hashed: true }) }])
    await expect(getBraveCookieHeader('opencode.ai', { dbPath, run: secretTool('', 1) })).rejects.toMatchObject({
      kind: 'auth',
      message: 'No puedo acceder al llavero de GNOME',
    })
  })
})

describe('keyringPassword', () => {
  it('queries secret-tool once and caches the result', async () => {
    const run = vi.fn(secretTool('pw\n'))
    const get = keyringPassword(run)
    expect(await get()).toBe('pw')
    expect(await get()).toBe('pw')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]!.slice(0, 2)).toEqual(['secret-tool', ['lookup', 'application', 'brave']])
  })
})
