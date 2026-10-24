import { mkdtemp, readFile, rm, mkdir, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderReading } from 'core'
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
      localReaders: [{ provider: 'antigravity' as const, read: async () => reading('antigravity') }],
      localHttpProviders: [],
      log: (m: string) => logs.push(m),
      logError: (m: string) => errors.push(m),
      sleep: async () => {},
      ...over,
    },
  }
}

describe('runOnce Cursor token sync', () => {
  const ok = () => new Response(null, { status: 204 })

  it('uploads a new token as a cursor credential and stores its hash after success', async () => {
    const fetchFn = vi.fn(async () => ok())
    const { d } = deps({ fetch: fetchFn, readCursorToken: async () => 'tok-abc' })
    await runOnce(cfg, d)
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.credentials).toEqual([{ provider: 'cursor', value: JSON.stringify({ accessToken: 'tok-abc' }) }])
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    expect(state.cursorTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(state)).not.toContain('tok-abc')
  })

  it('does not upload an unchanged token again', async () => {
    const fetchFn = vi.fn(async () => ok())
    const { d } = deps({ fetch: fetchFn, readCursorToken: async () => 'tok-abc' })
    await runOnce(cfg, d)
    await runOnce(cfg, d)
    const second = JSON.parse((fetchFn.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)
    expect(second.credentials).toBeUndefined()
  })

  it('uploads again when the token changes', async () => {
    const fetchFn = vi.fn(async () => ok())
    let token = 'tok-1'
    const { d } = deps({ fetch: fetchFn, readCursorToken: async () => token })
    await runOnce(cfg, d)
    token = 'tok-2'
    await runOnce(cfg, d)
    const second = JSON.parse((fetchFn.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)
    expect(second.credentials).toHaveLength(1)
  })

  it('does not store the hash when the ingest fails, so it is retried', async () => {
    const { d } = deps({
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
      readCursorToken: async () => 'tok-abc',
    })
    await runOnce(cfg, d)
    await expect(readFile(statePath, 'utf8')).rejects.toThrow()
    const fetchFn = vi.fn(async () => ok())
    await runOnce(cfg, { ...d, fetch: fetchFn })
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.credentials).toHaveLength(1)
  })

  it('skips Cursor when disabled or when the token is unreadable', async () => {
    const fetchFn = vi.fn(async () => ok())
    const reader = vi.fn(async () => 'tok')
    const { d } = deps({ fetch: fetchFn, readCursorToken: reader })
    await runOnce({ ...cfg, disabled: ['cursor'] as never[] }, d)
    expect(reader).not.toHaveBeenCalled()

    const { d: d2, errors } = deps({
      fetch: fetchFn,
      readCursorToken: async () => {
        throw new Error('database disk image is malformed')
      },
    })
    expect(await runOnce(cfg, d2)).toBe(0)
    expect(errors.join('\n')).toMatch(/Cursor/)
  })

  it('does not fail the run when the hash cannot be saved', async () => {
    const ro = join(dir, 'ro')
    await mkdir(ro)
    await chmod(ro, 0o500)
    const { d, errors } = deps({
      fetch: async () => ok(),
      readCursorToken: async () => 'tok-abc',
      statePath: join(ro, 'state.json'),
    })
    expect(await runOnce(cfg, d)).toBe(0)
    expect(errors.join('\n')).toMatch(/estado/)
    await chmod(ro, 0o700)
  })
})
