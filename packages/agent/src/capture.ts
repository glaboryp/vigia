import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CLOUD_PROVIDERS, LOCAL_HTTP_PROVIDERS } from 'core'

const SENSITIVE_KEY = /token|secret|password|cookie|email|session|auth|key|id$/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export function redact(value: unknown): unknown {
  if (typeof value === 'string') return EMAIL.test(value) || JWT.test(value) ? 'REDACTED' : value
  if (Array.isArray(value)) return value.map(redact)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? 'REDACTED' : redact(v)]),
    )
  }
  return value
}

function sanitizePath(url: string): string {
  const path = new URL(url).pathname.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return path || 'root'
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

  const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../../core/test/fixtures', id)
  await mkdir(fixturesDir, { recursive: true })
  let n = 0
  const recordingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init)
    const text = await response.clone().text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const file = join(fixturesDir, `${++n}-${sanitizePath(url)}.json`)
    await writeFile(file, JSON.stringify(redact(body), null, 2) + '\n')
    console.log(file)
    return response
  }

  const result = await provider.read({
    fetch: recordingFetch,
    now: () => new Date(),
    credential: provider.parseCredential(raw.trim()),
  })
  if (!result.reading.ok) console.error(`Lectura fallida: ${result.reading.error.kind}`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
