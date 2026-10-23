import { describe, expect, it, vi } from 'vitest'
import { IngestError, postIngest } from '../src/ingest-client.ts'

const cfg = { workerUrl: 'https://vigia.example.workers.dev/', ingestToken: 'tok-123', disabled: [] }
const payload = { readings: [] }

describe('postIngest', () => {
  it('posts JSON with a Bearer token to /ingest', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }))
    await postIngest(cfg, { readings: [], credentials: [{ provider: 'cursor', value: 'v' }] }, fetchFn)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://vigia.example.workers.dev/ingest')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123')
    expect(JSON.parse(init.body as string)).toEqual({ readings: [], credentials: [{ provider: 'cursor', value: 'v' }] })
  })

  it('retries 503 honoring Retry-After capped at 60 s, then succeeds', async () => {
    const responses = [
      new Response(null, { status: 503, headers: { 'Retry-After': '30' } }),
      new Response(null, { status: 503, headers: { 'Retry-After': '999' } }),
      new Response(null, { status: 204 }),
    ]
    const fetchFn = vi.fn(async () => responses.shift()!)
    const sleep = vi.fn(async () => {})
    await postIngest(cfg, payload, fetchFn, sleep)
    expect(sleep.mock.calls).toEqual([[30_000], [60_000]])
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('gives up after 3 retries with a 503 error', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 503, headers: { 'Retry-After': '1' } }))
    const sleep = vi.fn(async () => {})
    await expect(postIngest(cfg, payload, fetchFn, sleep)).rejects.toMatchObject({ status: 503 })
    expect(fetchFn).toHaveBeenCalledTimes(4)
    expect(sleep).toHaveBeenCalledTimes(3)
  })

  it.each([400, 401])('throws immediately on %i', async (status) => {
    const fetchFn = vi.fn(async () => new Response(null, { status }))
    await expect(postIngest(cfg, payload, fetchFn, async () => {})).rejects.toMatchObject({ status })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('throws a network IngestError when fetch fails', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const err = await postIngest(cfg, payload, fetchFn).catch((e) => e)
    expect(err).toBeInstanceOf(IngestError)
    expect(err.network).toBe(true)
  })

  it('preserves a path prefix in workerUrl', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }))
    await postIngest({ ...cfg, workerUrl: 'https://h.example/vigia' }, payload, fetchFn)
    await postIngest({ ...cfg, workerUrl: 'https://h.example/vigia/' }, payload, fetchFn)
    expect(fetchFn.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual([
      'https://h.example/vigia/ingest',
      'https://h.example/vigia/ingest',
    ])
  })
})
