import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main, pushCredential } from '../src/push-credential.ts'

const cfg = { workerUrl: 'https://vigia.example.workers.dev', ingestToken: 'tok', disabled: [] }
const ok = () => vi.fn(async () => new Response(null, { status: 204 }))
const bodyOf = (f: ReturnType<typeof ok>) => JSON.parse(((f.mock.calls[0] as unknown as [string, RequestInit])[1]).body as string)

describe('pushCredential', () => {
  it('posts an empty readings list with the serialized credential', async () => {
    const f = ok()
    await pushCredential(cfg, 'copilot', '  ghu_secret \n', f)
    expect(bodyOf(f)).toEqual({ readings: [], credentials: [{ provider: 'copilot', value: 'ghu_secret' }] })
  })

  it('normalizes structured credentials through the provider', async () => {
    const f = ok()
    await pushCredential(cfg, 'qoder', 'pat-123', f)
    expect(bodyOf(f).credentials).toEqual([{ provider: 'qoder', value: '{"pat":"pat-123"}' }])
  })

  it('accepts a Codex auth.json', async () => {
    const f = ok()
    await pushCredential(cfg, 'codex', JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r' } }), f)
    expect(JSON.parse(bodyOf(f).credentials[0].value)).toMatchObject({ refreshToken: 'r' })
  })

  it('rejects unknown and local providers without posting', async () => {
    const f = ok()
    await expect(pushCredential(cfg, 'nope', 'x', f)).rejects.toThrow(/desconocido/)
    await expect(pushCredential(cfg, 'mimo', 'x', f)).rejects.toThrow(/no se sube/)
    expect(f).not.toHaveBeenCalled()
  })

  it('fails fast on an invalid credential without leaking it', async () => {
    const f = ok()
    const err = await pushCredential(cfg, 'codex', '{"secret-marker": 1', f).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).not.toContain('secret-marker')
    expect(f).not.toHaveBeenCalled()
  })
})

describe('main', () => {
  let dir: string
  let prev: string | undefined
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vigia-push-'))
    prev = process.env.VIGIA_CONFIG
    process.env.VIGIA_CONFIG = join(dir, 'agent.json')
    await writeFile(process.env.VIGIA_CONFIG, JSON.stringify(cfg), { mode: 0o600 })
    await writeFile(join(dir, 'cred.txt'), 'ghu_secret\n')
  })
  afterEach(async () => {
    if (prev === undefined) delete process.env.VIGIA_CONFIG
    else process.env.VIGIA_CONFIG = prev
    await rm(dir, { recursive: true, force: true })
  })

  it('reads config and file, posts, and never prints the credential', async () => {
    const f = ok()
    const out: string[] = []
    const code = await main(['copilot', join(dir, 'cred.txt')], { fetch: f, log: (m) => out.push(m), logError: (m) => out.push(m) })
    expect(code).toBe(0)
    expect(out.join('\n')).not.toContain('ghu_secret')
    expect(bodyOf(f).credentials[0].provider).toBe('copilot')
  })

  it('prints usage on missing args', async () => {
    const out: string[] = []
    expect(await main([], { logError: (m) => out.push(m) })).toBe(1)
    expect(out[0]).toMatch(/Uso/)
  })

  it('returns 1 when the Worker rejects', async () => {
    const f = vi.fn(async () => new Response(null, { status: 401 }))
    const out: string[] = []
    expect(await main(['copilot', join(dir, 'cred.txt')], { fetch: f, logError: (m) => out.push(m) })).toBe(1)
    expect(out.join('')).toContain('401')
  })
})
