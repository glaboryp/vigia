import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'

export const NOW = new Date('2026-10-23T10:00:00Z')

export function fixture(path: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url)), 'utf8'))
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init ?? {}))
}

export function ctx<C>(credential: C, fetchFn: ReturnType<typeof mockFetch>) {
  return { fetch: fetchFn as unknown as typeof fetch, now: () => NOW, credential }
}
