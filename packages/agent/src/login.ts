import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_LABELS, codexProvider, type ProviderId } from 'core'
import { runProcess, type Runner } from './antigravity.js'
import { loadConfig, type AgentConfig } from './config.js'
import { IngestError, postIngest } from './ingest-client.js'
import { validateCredential } from './push-credential.js'

export const LOGIN_IDS = ['copilot', 'codex', 'freebuff', 'kilo', 'qoder'] as const
type LoginId = (typeof LOGIN_IDS)[number]

const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98'
const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const SECRET_TOOL_TIMEOUT_MS = 10_000
const DEFAULT_POLL_INTERVAL_S = 5

export interface LoginDeps {
  home?: string
  env?: NodeJS.ProcessEnv
  cfg?: AgentConfig
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
  logError?: (message: string) => void
  runInteractive?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number | null>
  prompt?: (message: string) => Promise<string>
  secretTool?: Runner
}

interface Resolved {
  home: string
  env: NodeJS.ProcessEnv
  cfg: AgentConfig
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  log: (message: string) => void
  runInteractive: NonNullable<LoginDeps['runInteractive']>
  prompt: NonNullable<LoginDeps['prompt']>
  secretTool: Runner
}

const labelOf = (id: string) => PROVIDER_LABELS[id as ProviderId] ?? id

const defaultInteractive: NonNullable<LoginDeps['runInteractive']> = (cmd, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code) => resolve(code))
  })

const defaultSecretTool: Runner = (cmd, args, env) => runProcess(cmd, args, env, { timeoutMs: SECRET_TOOL_TIMEOUT_MS })

function hiddenPrompt(message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    if (!stdin.isTTY) {
      reject(new Error('Necesito un terminal interactivo para pedirte la credencial'))
      return
    }
    process.stdout.write(`${message} `)
    let value = ''
    const done = (fn: () => void) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      process.stdout.write('\n')
      fn()
    }
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(value))
        if (ch === '\x03') return done(() => reject(new Error('Cancelado')))
        if (ch === '\x7f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

async function upload(id: string, raw: string, r: Resolved): Promise<void> {
  const credential = validateCredential(id, raw)
  await postIngest(r.cfg, { readings: [], credentials: [credential] }, r.fetch, r.sleep)
  r.log(`✅ Credencial de ${labelOf(id)} subida.`)
}

async function runCli(cmd: string, args: string[], env: NodeJS.ProcessEnv, r: Resolved): Promise<void> {
  let code: number | null
  try {
    code = await r.runInteractive(cmd, args, env)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${cmd} no está instalado o no está en el PATH`)
    }
    throw err
  }
  if (code !== 0) throw new Error(`${cmd} ${args.join(' ')} terminó con error`)
}

async function readAuthFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function loginViaCli(id: 'codex', r: Resolved): Promise<void> {
  const dir = join(r.home, '.vigia', id)
  const authPath = join(dir, 'auth.json')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await runCli(id, ['login', '--device-auth'], { ...r.env, CODEX_HOME: dir }, r)
  const raw = await readAuthFile(authPath)
  if (raw === null) throw new Error(`${id} no ha creado ${authPath}`)
  codexProvider.parseCredential(raw)
  r.log('✅ Codex queda configurado en el portátil (el agente lo lee desde ahí).')
}

export async function copilotDeviceFlow(deps: {
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  log: (message: string) => void
}): Promise<string> {
  const post = (url: string, params: Record<string, string>) =>
    deps.fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'VigIA' },
      body: new URLSearchParams(params).toString(),
    })
  let start: Response
  try {
    start = await post(DEVICE_CODE_URL, { client_id: COPILOT_CLIENT_ID, scope: 'read:user' })
  } catch {
    throw new Error('No he podido conectar con GitHub')
  }
  if (!start.ok) throw new Error(`GitHub respondió HTTP ${start.status} al pedir el código de dispositivo`)
  const info = (await start.json()) as Record<string, unknown>
  const { device_code, user_code, verification_uri } = info
  if (typeof device_code !== 'string' || typeof user_code !== 'string' || typeof verification_uri !== 'string') {
    throw new Error('Respuesta inesperada de GitHub al pedir el código de dispositivo')
  }
  deps.log(`Abre ${verification_uri} e introduce el código ${user_code}`)
  let intervalS = typeof info.interval === 'number' && info.interval >= 0 ? info.interval : DEFAULT_POLL_INTERVAL_S
  const expiresS = typeof info.expires_in === 'number' ? info.expires_in : 900
  let waitedMs = 0
  while (waitedMs <= expiresS * 1000) {
    await deps.sleep(intervalS * 1000)
    waitedMs += intervalS * 1000
    let res: Response
    try {
      res = await post(ACCESS_TOKEN_URL, {
        client_id: COPILOT_CLIENT_ID,
        device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      })
    } catch {
      throw new Error('No he podido conectar con GitHub')
    }
    if (!res.ok) throw new Error(`GitHub respondió HTTP ${res.status} al esperar la autorización`)
    const body = (await res.json()) as Record<string, unknown>
    if (typeof body.access_token === 'string' && body.access_token !== '') return body.access_token
    switch (body.error) {
      case 'authorization_pending':
        break
      case 'slow_down':
        intervalS += 5
        break
      case 'expired_token':
        throw new Error('El código ha caducado; vuelve a ejecutar el login')
      case 'access_denied':
        throw new Error('Has rechazado la autorización en GitHub')
      default:
        throw new Error('Respuesta inesperada de GitHub al esperar la autorización')
    }
  }
  throw new Error('El código ha caducado; vuelve a ejecutar el login')
}

async function loginFreebuff(r: Resolved): Promise<void> {
  const dir = r.env.FREEBUFF_CONFIG_DIR || join(r.home, '.config', 'manicode')
  const account = join(dir, 'credentials.json')
  const notFound = new Error('Inicia sesión en Freebuff (ejecuta freebuff) y vuelve a probar')
  let result
  try {
    result = await r.secretTool('secret-tool', ['lookup', 'service', 'freebuff-cli', 'account', account], r.env)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Instala libsecret-tools (sudo apt install libsecret-tools) para leer el token de Freebuff')
    }
    throw notFound
  }
  let secret = result.code === 0 ? result.stdout.trim() : ''
  if (secret === '') throw notFound
  if (secret.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(secret)
      const token = (parsed as Record<string, unknown> | null)?.authToken
      secret = typeof token === 'string' ? token.trim() : ''
    } catch {
      secret = ''
    }
    if (secret === '') throw notFound
  }
  await upload('freebuff', secret, r)
}

async function loginPrompted(id: 'kilo' | 'qoder', r: Resolved): Promise<void> {
  const message =
    id === 'kilo'
      ? 'Copia tu API key de https://app.kilo.ai/profile y pégala aquí:'
      : 'Crea un Personal Access Token en https://qoder.com/account/integrations y pégalo aquí:'
  const answer = (await r.prompt(message)).trim()
  if (answer === '') throw new Error('La credencial está vacía')
  await upload(id, answer, r)
}

function resolve(deps: LoginDeps, cfg: AgentConfig): Resolved {
  return {
    home: deps.home ?? homedir(),
    env: deps.env ?? process.env,
    cfg,
    fetch: deps.fetch ?? fetch,
    sleep: deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))),
    log: deps.log ?? ((m) => console.log(m)),
    runInteractive: deps.runInteractive ?? defaultInteractive,
    prompt: deps.prompt ?? hiddenPrompt,
    secretTool: deps.secretTool ?? defaultSecretTool,
  }
}

export async function loginProvider(id: LoginId, deps: LoginDeps): Promise<void> {
  if (!deps.cfg) throw new Error('Falta la configuración del agente')
  const r = resolve(deps, deps.cfg)
  switch (id) {
    case 'copilot':
      return upload('copilot', await copilotDeviceFlow(r), r)
    case 'codex':
      return loginViaCli(id, r)
    case 'freebuff':
      return loginFreebuff(r)
    case 'kilo':
    case 'qoder':
      return loginPrompted(id, r)
  }
}

function describeError(err: unknown): string {
  if (err instanceof IngestError) return `No he podido subir la credencial: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}

export async function main(argv: string[], deps: LoginDeps = {}): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m))
  const logError = deps.logError ?? ((m: string) => console.error(m))
  const [arg] = argv
  const ids = LOGIN_IDS as readonly string[]
  if (!arg || (arg !== 'all' && !ids.includes(arg))) {
    logError(`Uso: login <herramienta | all>\nHerramientas: ${LOGIN_IDS.join(', ')}`)
    return 1
  }
  let cfg: AgentConfig
  try {
    cfg = deps.cfg ?? (await loadConfig())
  } catch (err) {
    logError(describeError(err))
    return 1
  }
  const targets = arg === 'all' ? [...LOGIN_IDS] : [arg as LoginId]
  const failed: string[] = []
  const succeeded: string[] = []
  for (const id of targets) {
    if (targets.length > 1) log(`\n== ${labelOf(id)} ==`)
    try {
      await loginProvider(id, { ...deps, log, cfg })
      succeeded.push(id)
    } catch (err) {
      failed.push(id)
      logError(`${labelOf(id)}: ${describeError(err)}`)
    }
  }
  if (targets.length > 1) {
    log(`\nResumen: subidas ${succeeded.join(', ') || 'ninguna'}`)
    if (failed.length > 0) logError(`Resumen: con error ${failed.join(', ')}`)
  }
  return failed.length > 0 ? 1 : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2))
    .catch(() => {
      console.error('Error inesperado')
      return 1
    })
    .then((code) => process.exit(code))
}
