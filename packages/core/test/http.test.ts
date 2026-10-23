import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderError, classifyHttp, errorFromUnknown, fetchJson } from '../src/http.js'
import { errorReading, okReading } from '../src/providers/contract.js'
import { CLOUD_PROVIDERS, LOCAL_HTTP_PROVIDERS } from '../src/providers/registry.js'

const NOW = new Date('2026-10-23T10:00:00Z')

afterEach(() => {
  vi.useRealTimers()
})

describe('classifyHttp', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [408, 'network'],
    [429, 'network'],
    [500, 'network'],
    [503, 'network'],
    [404, 'unavailable'],
    [400, 'unavailable'],
    [200, null],
    [204, null],
    [302, null],
  ])('maps %i to %s', (status, kind) => {
    expect(classifyHttp(status)).toBe(kind)
  })
})

describe('fetchJson', () => {
  it('parses a JSON body', async () => {
    const fetchFn = vi.fn(async () => new Response('{"a":1}', { status: 200 }))
    expect(await fetchJson({ fetch: fetchFn }, 'https://x.test')).toEqual({ status: 200, body: { a: 1 } })
  })

  it('returns text for a non-2xx non-JSON body without throwing', async () => {
    const fetchFn = vi.fn(async () => new Response('boom', { status: 502 }))
    expect(await fetchJson({ fetch: fetchFn }, 'https://x.test')).toEqual({ status: 502, body: 'boom' })
  })

  it('returns parsed JSON on non-2xx', async () => {
    const fetchFn = vi.fn(async () => new Response('{"error":"nope"}', { status: 401 }))
    expect(await fetchJson({ fetch: fetchFn }, 'https://x.test')).toEqual({ status: 401, body: { error: 'nope' } })
  })

  it('throws parse on a non-JSON 2xx body', async () => {
    const fetchFn = vi.fn(async () => new Response('<html>', { status: 200 }))
    await expect(fetchJson({ fetch: fetchFn }, 'https://x.test')).rejects.toMatchObject({ kind: 'parse' })
  })

  it('throws network when fetch rejects', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const err = await fetchJson({ fetch: fetchFn }, 'https://x.test').catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.kind).toBe('network')
  })

  it('aborts after 15s by default with a network error', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        }),
    )
    const p = fetchJson({ fetch: fetchFn as unknown as typeof fetch }, 'https://x.test')
    const assertion = expect(p).rejects.toMatchObject({ kind: 'network' })
    await vi.advanceTimersByTimeAsync(15_000)
    await assertion
  })
})

describe('readings', () => {
  it('builds ok and error readings', () => {
    expect(okReading('codex', 'cloud', [], NOW)).toEqual({
      provider: 'codex',
      ok: true,
      quotas: [],
      readAt: NOW.toISOString(),
      source: 'cloud',
    })
    expect(errorReading('codex', 'cloud', 'auth', 'x', NOW)).toEqual({
      provider: 'codex',
      ok: false,
      error: { kind: 'auth', message: 'x' },
      readAt: NOW.toISOString(),
      source: 'cloud',
    })
  })

  it('maps unknown errors', () => {
    const a = errorFromUnknown('kilo', 'cloud', new ProviderError('parse', 'bad'), NOW)
    expect(a).toMatchObject({ ok: false, error: { kind: 'parse', message: 'bad' } })
    const b = errorFromUnknown('kilo', 'cloud', new Error('weird'), NOW)
    expect(b).toMatchObject({ ok: false, error: { kind: 'unavailable', message: 'weird' } })
  })
})

describe('registry', () => {
  it('starts empty', () => {
    expect(CLOUD_PROVIDERS).toEqual([])
    expect(LOCAL_HTTP_PROVIDERS).toEqual([])
  })
})
