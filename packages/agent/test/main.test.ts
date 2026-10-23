import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
