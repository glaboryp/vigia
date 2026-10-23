import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRecordingFetch, credentialSecrets, redact, redactText, sanitizePath } from '../src/capture.js'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl'

describe('redact', () => {
  it('keeps quota data', () => {
    const input = {
      tokens_used: 123,
      remaining_tokens: 40,
      session: { used: 3, limit: 10, resets_at: '2026-10-24T00:00:00Z' },
      paid: true,
      valid: false,
      nothing: null,
    }
    expect(redact(input)).toEqual(input)
  })

  it('redacts sensitive string keys and ids', () => {
    expect(
      redact({ org_id: 'wrk_123', userId: 'u1', id: 'abc', email: 'x', name: 'Gloria', access_token: 'a', Password: 'b', plan: 'pro' }),
    ).toEqual({
      org_id: 'REDACTED',
      userId: 'REDACTED',
      id: 'REDACTED',
      email: 'REDACTED',
      name: 'REDACTED',
      access_token: 'REDACTED',
      Password: 'REDACTED',
      plan: 'pro',
    })
  })

  it('recurses into containers under sensitive keys', () => {
    expect(redact({ session: { used: 1 }, items: [{ email: 'x', limit: 5 }] })).toEqual({
      session: { used: 1 },
      items: [{ email: 'REDACTED', limit: 5 }],
    })
  })

  it('redacts embedded emails and JWTs', () => {
    expect(redact({ note: 'contact me@example.com today', blob: `Bearer ${JWT}`, other: 'hello' })).toEqual({
      note: 'contact REDACTED today',
      blob: 'Bearer REDACTED',
      other: 'hello',
    })
  })
})

describe('redactText', () => {
  it('replaces credential strings, including JSON-escaped ones', () => {
    expect(redactText('a supersecretvalue b', ['supersecretvalue'])).toBe('a REDACTED b')
    expect(redactText('{"c":"say \\"hi\\" there"}', ['say "hi" there'])).toBe('{"c":"REDACTED"}')
  })

  it('collects raw and long string fields of the credential', () => {
    expect(credentialSecrets(' raw-cred \n', { a: 'longenough1', b: 'short', c: 5 })).toEqual(['raw-cred', 'longenough1'])
  })
})

describe('sanitizePath', () => {
  it('replaces id-like segments and caps length', () => {
    expect(sanitizePath('https://x.test/v1/users/0123456789abcdef0123456789abcdef/usage')).toBe('v1-users-x-usage')
    expect(sanitizePath('https://x.test/')).toBe('root')
    expect(sanitizePath(`https://x.test/${'a-b/'.repeat(60)}`).length).toBeLessThanOrEqual(80)
  })
})

describe('createRecordingFetch', () => {
  it('writes a redacted fixture and returns the original response', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vigia-'))
    const body = JSON.stringify({ email: 'a@b.co', used: 4, note: 'key sk-secret-credential-123' })
    const base = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    const logged: string[] = []
    const rec = createRecordingFetch(dir, ['sk-secret-credential-123'], (f) => logged.push(f), base)
    const res = await rec('https://x.test/api/usage')
    expect(await res.text()).toBe(body)
    const files = await readdir(dir)
    expect(files).toEqual(['1-api-usage.json'])
    expect(logged).toEqual([join(dir, '1-api-usage.json')])
    const saved = JSON.parse(await readFile(join(dir, files[0]!), 'utf8'))
    expect(saved).toEqual({ email: 'REDACTED', used: 4, note: 'key REDACTED' })
  })

  it('saves non-JSON bodies as redacted .txt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vigia-'))
    const base = (async () => new Response('hi a@b.co tok_abcdefgh', { status: 200 })) as unknown as typeof fetch
    const rec = createRecordingFetch(dir, ['tok_abcdefgh'], () => {}, base)
    await rec('https://x.test/plain')
    const files = await readdir(dir)
    expect(files).toEqual(['1-plain.txt'])
    expect(await readFile(join(dir, files[0]!), 'utf8')).toBe('hi REDACTED REDACTED')
  })
})
