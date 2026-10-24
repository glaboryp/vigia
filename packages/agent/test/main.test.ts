import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_HTTP_PROVIDERS, type ProviderReading } from 'core'
import { runOnce } from '../src/main.ts'

const cfg = { workerUrl: 'https://w.example', ingestToken: 'tok', disabled: [] as never[] }
const NOW = new Date('2026-10-23T10:00:00Z')
const reading = (provider: 'antigravity' | 'mimo'): ProviderReading => ({
  provider,
  ok: true,
  quotas: [],
  readAt: NOW.toISOString(),
  source: 'local',
})

let dir: string
let statePath: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vigia-main-'))
  statePath = join(dir, 'state.json')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

function deps(over: Record<string, unknown> = {}) {
  const logs: string[] = []
  const errors: string[] = []
  return {
    logs,
    errors,
    d: {
      statePath,
      readCursorToken: async () => null,
      localHttpProviders: [],
      localReaders: [{ provider: 'antigravity' as const, read: async () => reading('antigravity') }],
      log: (m: string) => logs.push(m),
      logError: (m: string) => errors.push(m),
      sleep: async () => {},
      ...over,
    },
  }
}

describe('runOnce', () => {
  it('posts the local readings once and returns 0', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }))
    const { d } = deps({ fetch: fetchFn })
    expect(await runOnce(cfg, d)).toBe(0)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.readings).toHaveLength(1)
    expect(body.credentials).toBeUndefined()
  })

  it('skips disabled providers', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }))
    const { d } = deps({ fetch: fetchFn })
    await runOnce({ ...cfg, disabled: ['antigravity'] as never[] }, d)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('exits 0 with a log line when there is no network', async () => {
    const { d, logs } = deps({
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
    })
    expect(await runOnce(cfg, d)).toBe(0)
    expect(logs.join('\n')).toMatch(/Sin conexión/)
  })

  it('exits 1 on 401 and 400', async () => {
    for (const status of [401, 400]) {
      const { d, errors } = deps({ fetch: async () => new Response(null, { status }) })
      expect(await runOnce(cfg, d)).toBe(1)
      expect(errors.join('\n')).toContain(String(status))
    }
  })

  it('isolates a throwing reader as an unavailable reading', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }))
    const { d } = deps({
      fetch: fetchFn,
      localReaders: [
        {
          provider: 'antigravity',
          read: async () => {
            throw new Error('boom')
          },
        },
        { provider: 'mimo', read: async () => reading('mimo') },
      ],
    })
    expect(await runOnce(cfg, d)).toBe(0)
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.readings.map((r: ProviderReading) => [r.provider, r.ok])).toEqual([
      ['antigravity', false],
      ['mimo', true],
    ])
  })
})

describe('runOnce with local HTTP providers', () => {
  const COOKIE = 'session=SUPERSECRETCOOKIE'
  const hosts = { mimo: 'platform.xiaomimimo.com', opencode: 'opencode.ai' }

  it('reads mimo and opencode with their cookie, never sending the cookie', async () => {
    const seen: string[] = []
    const fetchFn = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('w.example')) return new Response(null, { status: 204 })
      seen.push(new Headers(init?.headers).get('cookie') ?? '')
      return new Response('{}', { status: 200 })
    })
    const cookieFor = vi.fn(async (host: string) => (host === hosts.mimo ? COOKIE : null))
    const { d } = deps({ fetch: fetchFn, localReaders: [], localHttpProviders: LOCAL_HTTP_PROVIDERS, braveCookieHeader: cookieFor })
    expect(await runOnce(cfg, d)).toBe(0)
    expect(cookieFor).toHaveBeenCalledWith('platform.xiaomimimo.com')
    expect(cookieFor).toHaveBeenCalledWith('opencode.ai')
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((c) => c === COOKIE)).toBe(true)
    const ingest = fetchFn.mock.calls.find((c) => String(c[0]).includes('w.example'))!
    const raw = (ingest[1] as RequestInit).body as string
    expect(raw).not.toContain('SUPERSECRETCOOKIE')
    const body = JSON.parse(raw)
    const opencode = body.readings.find((r: ProviderReading) => r.provider === 'opencode')
    expect(opencode).toMatchObject({ ok: false, error: { kind: 'auth', message: 'Inicia sesión en opencode.ai con Brave' } })
    expect(body.readings.map((r: ProviderReading) => r.provider).sort()).toEqual(['mimo', 'opencode'])
  })

  it('turns cookie errors into error readings and skips disabled providers', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }))
    const { ProviderError } = await import('core')
    const cookieFor = vi.fn(async () => {
      throw new ProviderError('auth', 'No puedo acceder al llavero de GNOME')
    })
    const { d } = deps({ fetch: fetchFn, localReaders: [], localHttpProviders: LOCAL_HTTP_PROVIDERS, braveCookieHeader: cookieFor })
    await runOnce({ ...cfg, disabled: ['opencode'] as never[] }, d)
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.readings).toHaveLength(1)
    expect(body.readings[0]).toMatchObject({ provider: 'mimo', ok: false, error: { kind: 'auth', message: 'No puedo acceder al llavero de GNOME' } })
  })
})

describe('runOnce keyring caching', () => {
  it('asks the keyring once for several v11 hosts', async () => {
    const { createCipheriv, pbkdf2Sync, createHash } = await import('node:crypto')
    const { DatabaseSync } = await import('node:sqlite')
    const { mkdir } = await import('node:fs/promises')
    const enc = (v: string, host: string) => {
      const c = createCipheriv('aes-128-cbc', pbkdf2Sync('pw', 'saltysalt', 1, 16, 'sha1'), Buffer.alloc(16, 0x20))
      return Buffer.concat([Buffer.from('v11'), c.update(Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(v)])), c.final()])
    }
    const profile = join(dir, 'Default')
    await mkdir(profile)
    const db = new DatabaseSync(join(profile, 'Cookies'))
    db.exec('CREATE TABLE meta (key TEXT UNIQUE NOT NULL, value TEXT)')
    db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER)')
    db.prepare('INSERT INTO meta VALUES (?, ?)').run('version', '24')
    const ins = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, 0)')
    ins.run('platform.xiaomimimo.com', 'a', '', enc('1', 'platform.xiaomimimo.com'))
    ins.run('opencode.ai', 'b', '', enc('2', 'opencode.ai'))
    db.close()
    const run = vi.fn(async () => ({ code: 0, stdout: 'pw\n', stderr: '' }))
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }))
    const { d } = deps({ fetch: fetchFn, localReaders: [], localHttpProviders: LOCAL_HTTP_PROVIDERS, braveProfileDir: profile, secretToolRun: run })
    await runOnce(cfg, d)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
