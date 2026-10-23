import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stat } from 'node:fs/promises'
import { readAntigravity } from '../src/antigravity.ts'

const fixture = await readFile(new URL('./fixtures/antigravity-usage.json', import.meta.url), 'utf8')
const NOW = new Date('2026-10-23T10:00:00Z')

type Call = { cmd: string; args: string[]; env: NodeJS.ProcessEnv }

function fakeRun(usage: { code?: number | null; stdout?: string; stderr?: string }, version = 'agy 1.2.11\n') {
  const calls: Call[] = []
  const run = vi.fn(async (cmd: string, args: string[], env: NodeJS.ProcessEnv) => {
    calls.push({ cmd, args, env })
    if (args[0] === '--version') return { code: 0, stdout: version, stderr: '' }
    return { code: 'code' in usage ? (usage.code as number) : 0, stdout: usage.stdout ?? '', stderr: usage.stderr ?? '' }
  })
  return { run, calls }
}

let dir: string
let statePath: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vigia-agy-'))
  statePath = join(dir, 'state.json')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('readAntigravity', () => {
  it('maps the real captured output to two weekly quotas', async () => {
    const { run, calls } = fakeRun({ stdout: fixture })
    const reading = await readAntigravity(run, () => NOW, { statePath })
    expect(reading).toEqual({
      provider: 'antigravity',
      ok: true,
      source: 'local',
      readAt: NOW.toISOString(),
      quotas: [
        {
          provider: 'antigravity',
          quotaId: 'gemini-weekly',
          name: 'Gemini Models',
          window: 'weekly',
          remainingFraction: 0,
          resetsAt: '2026-10-26T09:54:21Z',
        },
        {
          provider: 'antigravity',
          quotaId: '3p-weekly',
          name: 'Claude and GPT models',
          window: 'weekly',
          remainingFraction: 0.058038000017404556,
          resetsAt: '2026-10-26T14:13:14Z',
        },
      ],
    })
    const usage = calls.find((c) => c.args[0] === '-p')!
    expect(usage.args).toEqual(['-p', '/usage', '--output-format', 'json', '--print-timeout', '20s'])
    expect(usage.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true')
    expect(usage.env.PATH).toContain('.local/bin')
  })

  it('skips buckets whose window is not weekly or that are disabled', async () => {
    const data = JSON.parse(fixture)
    const group = data.command.data.groups[0]
    group.buckets.push({ id: 'gemini-5h', name: '5h', window: '5h', remaining_fraction: 1, reset_time: '2026-10-23T15:00:00Z' })
    group.buckets.push({ id: 'x-weekly', name: 'x', window: 'weekly', disabled: true, remaining_fraction: 1, reset_time: '2026-10-26T00:00:00Z' })
    const { run } = fakeRun({ stdout: JSON.stringify(data) })
    const reading = await readAntigravity(run, () => NOW, { statePath })
    expect(reading.ok && reading.quotas.map((q) => q.quotaId)).toEqual(['gemini-weekly', '3p-weekly'])
  })

  it('is unavailable below agy 1.1.11 and never runs the usage command', async () => {
    const { run, calls } = fakeRun({ stdout: fixture }, 'agy 1.0.0\n')
    const reading = await readAntigravity(run, () => NOW, { statePath })
    expect(reading.ok).toBe(false)
    if (!reading.ok) expect(reading.error.kind).toBe('unavailable')
    expect(calls.some((c) => c.args[0] === '-p')).toBe(false)
  })

  it('is unavailable when agy is not installed', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' })
    })
    const reading = await readAntigravity(run, () => NOW, { statePath })
    expect(reading).toMatchObject({
      ok: false,
      error: { kind: 'unavailable', message: 'No encuentro el CLI de Antigravity (agy)' },
    })
  })

  it('classifies signed-out output as auth', async () => {
    const { run } = fakeRun({ code: 1, stderr: 'Error: not signed in. Please sign in to Antigravity.' })
    const reading = await readAntigravity(run, () => NOW, { statePath })
    expect(reading).toMatchObject({ ok: false, error: { kind: 'auth' } })
  })

  it('reports a timeout as unavailable', async () => {
    const { run } = fakeRun({ code: null as unknown as number })
    const reading = await readAntigravity(run, () => NOW, { statePath })
    expect(reading).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
  })

  it('latches after a model turn, across calls and restarts, until the version changes', async () => {
    const turn = JSON.stringify({ status: 'SUCCESS', response: 'hola', conversation_id: 'abc', num_turns: 1 })
    const first = fakeRun({ stdout: turn })
    const r1 = await readAntigravity(first.run, () => NOW, { statePath })
    expect(r1).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
    expect(JSON.parse(await readFile(statePath, 'utf8')).antigravityModelTurn).toEqual({ version: '1.2.11' })

    const second = fakeRun({ stdout: fixture })
    const r2 = await readAntigravity(second.run, () => NOW, { statePath })
    expect(r2.ok).toBe(false)
    expect(second.calls.some((c) => c.args[0] === '-p')).toBe(false)

    const third = fakeRun({ stdout: fixture }, 'agy 1.3.0\n')
    const r3 = await readAntigravity(third.run, () => NOW, { statePath })
    expect(r3.ok).toBe(true)
    expect(JSON.parse(await readFile(statePath, 'utf8')).antigravityModelTurn).toBeUndefined()
  })

  it('keeps unrelated state when latching', async () => {
    await writeFile(statePath, JSON.stringify({ cursorTokenHash: 'abc' }))
    const turn = JSON.stringify({ status: 'SUCCESS', conversation_id: 'abc', num_turns: 2 })
    await readAntigravity(fakeRun({ stdout: turn }).run, () => NOW, { statePath })
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({
      cursorTokenHash: 'abc',
      antigravityModelTurn: { version: '1.2.11' },
    })
  })

  it('is unavailable when the version output cannot be parsed', async () => {
    const { run, calls } = fakeRun({ stdout: fixture }, 'garbage\n')
    const reading = await readAntigravity(run, () => NOW, { statePath })
    expect(reading).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
    expect(calls.some((c) => c.args[0] === '-p')).toBe(false)
  })

  it('parses pretty-printed JSON stdout', async () => {
    const { run } = fakeRun({ stdout: JSON.stringify(JSON.parse(fixture), null, 2) })
    expect((await readAntigravity(run, () => NOW, { statePath })).ok).toBe(true)
  })

  it('does not treat a bare "sign in" as signed out', async () => {
    const { run } = fakeRun({ code: 1, stderr: 'failed to sign in the websocket handshake' })
    const reading = await readAntigravity(run, () => NOW, { statePath })
    expect(reading).toMatchObject({ ok: false, error: { kind: 'parse' } })
  })

  it('stores state with mode 0600 in a 0700 directory', async () => {
    const nested = join(dir, 'sub', 'state.json')
    const turn = JSON.stringify({ status: 'SUCCESS', conversation_id: 'abc', num_turns: 1 })
    await readAntigravity(fakeRun({ stdout: turn }).run, () => NOW, { statePath: nested })
    expect((await stat(nested)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'sub'))).mode & 0o777).toBe(0o700)
  })

  it('latches after 2 consecutive timeouts, resets on success or version change', async () => {
    const timeout = () => fakeRun({ code: null as unknown as number })
    await readAntigravity(timeout().run, () => NOW, { statePath })
    expect(JSON.parse(await readFile(statePath, 'utf8')).antigravityTimeouts).toEqual({ version: '1.2.11', count: 1 })
    const ok = await readAntigravity(fakeRun({ stdout: fixture }).run, () => NOW, { statePath })
    expect(ok.ok).toBe(true)
    expect(JSON.parse(await readFile(statePath, 'utf8')).antigravityTimeouts).toBeUndefined()

    await readAntigravity(timeout().run, () => NOW, { statePath })
    await readAntigravity(timeout().run, () => NOW, { statePath })
    const blocked = fakeRun({ stdout: fixture })
    expect((await readAntigravity(blocked.run, () => NOW, { statePath })).ok).toBe(false)
    expect(blocked.calls.some((c) => c.args[0] === '-p')).toBe(false)

    const newer = fakeRun({ stdout: fixture }, 'agy 1.3.0\n')
    expect((await readAntigravity(newer.run, () => NOW, { statePath })).ok).toBe(true)
  })
})
