import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CLOUD_PROVIDERS, LOCAL_HTTP_PROVIDERS } from 'core'

const SENSITIVE_KEY =
  /^(access_?token|refresh_?token|id_?token|token|api_?key|secret|client_?secret|password|cookie|session_?token|authorization|email|e_?mail|username|user_?name|display_?name|name|login|phone)$/i
const ID_KEY = /(^|_)id$|[a-z]Id$/
const EMAIL = /[^\s@"]+@[^\s@"]+\.[^\s@"]+/g
const JWT = /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
const ID_SEGMENT = /^[A-Za-z0-9_-]{16,}$|^[0-9a-f-]{32,}$/

export function redactText(text: string, secrets: string[] = []): string {
  let out = text
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (!secret) continue
    out = out.split(secret).join('REDACTED')
    const escaped = JSON.stringify(secret).slice(1, -1)
    if (escaped !== secret) out = out.split(escaped).join('REDACTED')
  }
  return out.replace(JWT, 'REDACTED').replace(EMAIL, 'REDACTED')
}

export function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(redact)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        typeof v === 'string' && (SENSITIVE_KEY.test(k) || ID_KEY.test(k)) ? 'REDACTED' : redact(v),
      ]),
    )
  }
  return value
}

export function credentialSecrets(raw: string, parsed: unknown): string[] {
  const secrets = [raw.trim()]
  if (parsed !== null && typeof parsed === 'object') {
    for (const v of Object.values(parsed)) if (typeof v === 'string' && v.length >= 8) secrets.push(v)
  }
  return secrets.filter(Boolean)
}

export function sanitizePath(url: string): string {
  const segments = new URL(url).pathname
    .split('/')
    .filter(Boolean)
    .map((s) => (ID_SEGMENT.test(s) ? 'x' : s.replace(/[^A-Za-z0-9]+/g, '-')))
  return segments.join('-').replace(/^-+|-+$/g, '').slice(0, 80) || 'root'
}

export function createRecordingFetch(
  dir: string,
  secrets: string[],
  log: (path: string) => void,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  let n = 0
  return async (input, init) => {
    const response = await baseFetch(input, init)
    const text = await response.clone().text()
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let content: string
    let ext: string
    try {
      content = JSON.stringify(redact(JSON.parse(text)), null, 2) + '\n'
      ext = 'json'
    } catch {
      content = text
      ext = 'txt'
    }
    content = redactText(content, secrets)
    const file = join(dir, `${++n}-${sanitizePath(url)}.${ext}`)
    await mkdir(dir, { recursive: true })
    await writeFile(file, content)
    log(file)
    return response
  }
}

function parseArgs(argv: string[]): { id?: string; credentialFile?: string } {
  const out: { id?: string; credentialFile?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--credential-file') out.credentialFile = argv[++i]
    else if (!arg.startsWith('--') && out.id === undefined) out.id = arg
  }
  return out
}

export async function main(argv: string[]): Promise<number> {
  const { id, credentialFile } = parseArgs(argv)
  if (!id) {
    console.error('Uso: capture <providerId> [--credential-file <ruta>]')
    return 1
  }
  const provider = [...CLOUD_PROVIDERS, ...LOCAL_HTTP_PROVIDERS].find((p) => p.id === id)
  if (!provider) {
    console.error(`Proveedor desconocido: ${id}`)
    return 1
  }
  const envName = `VIGIA_CRED_${id.toUpperCase()}`
  const raw = credentialFile ? await readFile(credentialFile, 'utf8') : process.env[envName]
  if (raw === undefined) {
    console.error(`Falta la credencial: usa --credential-file o la variable ${envName}`)
    return 1
  }

  const credential = provider.parseCredential(raw.trim())
  const secrets = credentialSecrets(raw, credential)
  const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../core/test/fixtures', id)
  const result = await provider.read({
    fetch: createRecordingFetch(fixturesDir, secrets, (f) => console.log(f)),
    now: () => new Date(),
    credential,
  })
  if (!result.reading.ok) {
    const { kind, message } = result.reading.error
    console.error(`Lectura fallida (${kind}): ${redactText(message, secrets)}`)
    return 1
  }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2))
    .catch(() => {
      console.error('Error inesperado durante la captura')
      return 1
    })
    .then((code) => process.exit(code))
}
