import { describe, expect, it } from 'vitest'
import { decrypt, encrypt } from '../src/crypto.js'

const newKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))

describe('crypto', () => {
  it('roundtrips plaintext', async () => {
    const key = newKey()
    const payload = await encrypt(key, 'secret-token')
    expect(payload).not.toContain('secret-token')
    expect(await decrypt(key, payload)).toBe('secret-token')
  })

  it('uses a fresh IV per encryption', async () => {
    const key = newKey()
    expect(await encrypt(key, 'x')).not.toBe(await encrypt(key, 'x'))
  })

  it('throws with a different key', async () => {
    const payload = await encrypt(newKey(), 'secret')
    await expect(decrypt(newKey(), payload)).rejects.toThrow()
  })

  it('rejects tampered ciphertext', async () => {
    const key = newKey()
    const bytes = Uint8Array.from(atob(await encrypt(key, 'secret')), (c) => c.charCodeAt(0))
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
    await expect(decrypt(key, btoa(String.fromCharCode(...bytes)))).rejects.toThrow()
  })

  it('binds ciphertext to aad', async () => {
    const key = newKey()
    const payload = await encrypt(key, 'secret', 'codex')
    expect(await decrypt(key, payload, 'codex')).toBe('secret')
    await expect(decrypt(key, payload, 'qoder')).rejects.toThrow()
    await expect(decrypt(key, payload)).rejects.toThrow()
  })

  it('rejects keys that are not 32 bytes', async () => {
    await expect(encrypt(btoa('short'), 'x')).rejects.toThrow('CREDENTIALS_KEY must be 32 bytes base64')
  })
})
