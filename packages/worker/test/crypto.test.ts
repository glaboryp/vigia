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
})
