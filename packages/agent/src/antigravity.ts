import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { errorReading, okReading, type ErrorKind, type ProviderReading, type Quota } from 'core'
import { defaultStatePath, readState, writeState } from './state.js'

export type RunResult = { code: number | null; stdout: string; stderr: string }
export type Runner = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<RunResult>

export interface AntigravityOptions {
  statePath?: string
}

const MIN_VERSION = [1, 1, 11] as const
const USAGE_ARGS = ['-p', '/usage', '--output-format', 'json', '--print-timeout', '20s']
const VERSION_TIMEOUT_MS = 5_000
const USAGE_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 512 * 1024

const SIGNED_OUT_PHRASES = [
  'not logged into antigravity',
  'not logged in',
  'not signed in',
  'not authenticated',
  'unauthenticated',
  'run agy login',
  'please sign in',
  'please log in',
  'sign in',
  'no credentials',
  'authentication required',
]

function timeoutFor(args: string[]): number {
  return args[0] === '--version' ? VERSION_TIMEOUT_MS : USAGE_TIMEOUT_MS
}

export const defaultRun: Runner = (cmd, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const cap = (s: string, chunk: Buffer) => (s.length < MAX_OUTPUT_BYTES ? s + chunk.toString('utf8') : s)
    child.stdout.on('data', (c: Buffer) => (stdout = cap(stdout, c)))
    child.stderr.on('data', (c: Buffer) => (stderr = cap(stderr, c)))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutFor(args))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: timedOut ? null : code, stdout, stderr })
    })
  })

function probeEnv(): NodeJS.ProcessEnv {
  const localBin = join(homedir(), '.local', 'bin')
  const path = [process.env.PATH, localBin].filter(Boolean).join(delimiter)
  return { ...process.env, PATH: path, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }
}

function parseVersion(text: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(text)?.[0] ?? null
}

function versionAtLeast(version: string, min: readonly number[]): boolean {
  const parts = version.split('.').map(Number)
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0
    const b = min[i]!
    if (a !== b) return a > b
  }
  return true
}

function jsonLines(stdout: string): unknown[] {
  const out: unknown[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      continue
    }
  }
  return out
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function parseQuotas(envelope: unknown): Quota[] | null {
  if (!isRecord(envelope) || envelope.status !== 'SUCCESS') return null
  const command = envelope.command
  if (!isRecord(command) || command.name !== 'usage' || !isRecord(command.data)) return null
  const groups = command.data.groups
  if (!Array.isArray(groups)) return null
  const quotas: Quota[] = []
  for (const group of groups) {
    if (!isRecord(group) || typeof group.name !== 'string' || !Array.isArray(group.buckets)) continue
    for (const bucket of group.buckets) {
      if (!isRecord(bucket) || bucket.disabled === true || bucket.window !== 'weekly') continue
      const { id, remaining_fraction: fraction, reset_time: reset } = bucket
      if (typeof id !== 'string' || id === '') continue
      if (typeof fraction !== 'number' || !Number.isFinite(fraction)) continue
      if (typeof reset !== 'string' || Number.isNaN(Date.parse(reset))) continue
      quotas.push({
        provider: 'antigravity',
        quotaId: id,
        name: group.name,
        window: 'weekly',
        remainingFraction: Math.min(1, Math.max(0, fraction)),
        resetsAt: reset,
      })
    }
  }
  return quotas
}

function showsModelTurn(stdout: string): boolean {
  return jsonLines(stdout).some(
    (v) =>
      isRecord(v) &&
      ((typeof v.num_turns === 'number' && v.num_turns > 0) ||
        (typeof v.conversation_id === 'string' && v.conversation_id !== '')),
  )
}

function classifyFailure(output: string): ErrorKind | null {
  for (const line of output.split('\n')) {
    const i = line.indexOf('AGY_ERROR:')
    if (i === -1) continue
    try {
      const err: unknown = JSON.parse(line.slice(i + 'AGY_ERROR:'.length).trim())
      if (!isRecord(err)) continue
      const status = typeof err.status === 'string' ? err.status.toUpperCase() : ''
      const code = typeof err.error_code === 'number' ? err.error_code : null
      if (status === 'UNAUTHENTICATED' || code === 401) return 'auth'
      if (status === 'RESOURCE_EXHAUSTED' || code === 429 || (code !== null && code >= 500)) return 'network'
      if (status === 'PERMISSION_DENIED' || code === 403) return 'unavailable'
    } catch {
      continue
    }
  }
  const lowered = output.toLowerCase()
  return SIGNED_OUT_PHRASES.some((p) => lowered.includes(p)) ? 'auth' : null
}

export async function readAntigravity(
  run: Runner = defaultRun,
  now: () => Date = () => new Date(),
  options: AntigravityOptions = {},
): Promise<ProviderReading> {
  const statePath = options.statePath ?? defaultStatePath()
  const fail = (kind: ErrorKind, message: string) => errorReading('antigravity', 'local', kind, message, now())
  const env = probeEnv()

  let versionRun: RunResult
  try {
    versionRun = await run('agy', ['--version'], env)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return fail('unavailable', 'No encuentro el CLI de Antigravity (agy)')
    }
    return fail('unavailable', `No puedo ejecutar agy: ${err instanceof Error ? err.message : String(err)}`)
  }
  const version = versionRun.code === 0 ? parseVersion(versionRun.stdout || versionRun.stderr) : null
  if (!version || !versionAtLeast(version, MIN_VERSION)) {
    return fail(
      'unavailable',
      version
        ? `Antigravity necesita agy ${MIN_VERSION.join('.')} o superior (tienes ${version})`
        : 'No puedo leer la versión de agy',
    )
  }

  const state = await readState(statePath)
  const latched = state.antigravityModelTurn?.version
  if (latched === version) {
    return fail('unavailable', 'Esta versión de agy responde a /usage como un prompt; no la ejecuto para no gastar cuota')
  }
  if (latched !== undefined) {
    await writeState(statePath, ({ antigravityModelTurn: _drop, ...rest }) => rest)
  }

  let result: RunResult
  try {
    result = await run('agy', USAGE_ARGS, env)
  } catch (err) {
    return fail('unavailable', `No puedo ejecutar agy: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (result.code === null) return fail('unavailable', 'agy no respondió a tiempo')

  let quotas: Quota[] | null = null
  for (const value of jsonLines(result.stdout)) {
    quotas = parseQuotas(value)
    if (quotas) break
  }
  if (quotas && quotas.length > 0) return okReading('antigravity', 'local', quotas, now())

  if (!quotas && showsModelTurn(result.stdout)) {
    await writeState(statePath, (s) => ({ ...s, antigravityModelTurn: { version } }))
    return fail('unavailable', 'Esta versión de agy responde a /usage como un prompt; no la ejecuto para no gastar cuota')
  }
  const kind = classifyFailure(`${result.stdout}\n${result.stderr}`)
  if (kind === 'auth') return fail('auth', 'Antigravity no tiene la sesión iniciada; ejecuta agy e inicia sesión')
  if (kind === 'network') return fail('network', 'Antigravity no está disponible ahora mismo (límite o error del servidor)')
  if (kind === 'unavailable') return fail('unavailable', 'La cuenta no tiene acceso a la cuota de Antigravity')
  return fail('parse', 'agy no devolvió cuotas semanales')
}
