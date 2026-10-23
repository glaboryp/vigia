const IV_BYTES = 12

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64)
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
  return bytes
}

function importKey(keyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromBase64(keyB64), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encrypt(keyB64: string, plaintext: string): Promise<string> {
  const key = await importKey(keyB64)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  )
  const out = new Uint8Array(IV_BYTES + ct.length)
  out.set(iv)
  out.set(ct, IV_BYTES)
  return toBase64(out)
}

export async function decrypt(keyB64: string, payload: string): Promise<string> {
  const key = await importKey(keyB64)
  const data = fromBase64(payload)
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.slice(0, IV_BYTES) },
    key,
    data.slice(IV_BYTES),
  )
  return new TextDecoder().decode(pt)
}
