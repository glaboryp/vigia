import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readCodexLocal } from '../src/codex-local.js'

const NOW = new Date('2026-10-24T11:00:00Z')

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
}

const usage = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 25, limit_window_seconds: 604800, reset_after_seconds: 3600, reset_at: 1793000000 },
    secondary_window: null,
  },
}

function authJson(expSeconds: number): string {
  return JSON.stringify({
    tokens: {
      access_token: jwt({ exp: expSeconds }),
      refresh_token: 'rt-old',
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' } }),
      account_id: 'acc-1',
    },
    last_refresh: '2026-10-24T10:00:00Z',
  })
}

describe('readCodexLocal', () => {
  let dir: string
  let path: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codex-local-'))
    path = join(dir, 'auth.json')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads usage with the local login and marks the reading as local', async () => {
    await writeFile(path, authJson(NOW.getTime() / 1000 + 5 * 86400))
    const calls: string[] = []
    const fetchFn = (async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify(usage), { status: 200 })
    }) as typeof fetch
    const reading = await readCodexLocal({ path, fetch: fetchFn, now: () => NOW })
    expect(calls).toEqual(['https://chatgpt.com/backend-api/wham/usage'])
    expect(reading.ok).toBe(true)
    expect(reading.source).toBe('local')
    if (reading.ok) expect(reading.quotas[0]).toMatchObject({ provider: 'codex', window: 'weekly', remainingFraction: 0.75 })
  })

  it('writes a rotated credential back to the file with private permissions', async () => {
    await writeFile(path, authJson(NOW.getTime() / 1000 + 60))
    const fetchFn = (async (url: string) => {
      if (url.includes('oauth/token')) {
        return new Response(
          JSON.stringify({ access_token: jwt({ exp: NOW.getTime() / 1000 + 864000 }), refresh_token: 'rt-new' }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify(usage), { status: 200 })
    }) as typeof fetch
    const reading = await readCodexLocal({ path, fetch: fetchFn, now: () => NOW })
    expect(reading.ok).toBe(true)
    const saved = JSON.parse(await readFile(path, 'utf8'))
    expect(saved.refreshToken).toBe('rt-new')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('asks for the login when the file is missing', async () => {
    const reading = await readCodexLocal({ path, now: () => NOW })
    expect(reading).toMatchObject({ ok: false, source: 'local', error: { kind: 'auth' } })
    if (!reading.ok) expect(reading.error.message).toContain('login codex')
  })
})
