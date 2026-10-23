import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

let dir: string
let path: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vigia-cfg-'))
  path = join(dir, 'agent.json')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('loadConfig', () => {
  it('loads a 0600 config and defaults disabled to []', async () => {
    await writeFile(path, JSON.stringify({ workerUrl: 'https://w.example', ingestToken: 't' }), { mode: 0o600 })
    expect(await loadConfig(path)).toEqual({ workerUrl: 'https://w.example', ingestToken: 't', disabled: [] })
  })

  it('refuses a config readable by group or others', async () => {
    await writeFile(path, JSON.stringify({ workerUrl: 'https://w.example', ingestToken: 't' }))
    await chmod(path, 0o644)
    await expect(loadConfig(path)).rejects.toThrow(/chmod 600/)
  })

  it('explains how to create a missing config', async () => {
    await expect(loadConfig(path)).rejects.toThrow(/Créala/)
  })

  it('rejects missing fields', async () => {
    await writeFile(path, JSON.stringify({ workerUrl: 'https://w.example' }), { mode: 0o600 })
    await expect(loadConfig(path)).rejects.toThrow(/ingestToken/)
  })

  const write = (obj: unknown) => writeFile(path, JSON.stringify(obj), { mode: 0o600 })

  it('requires https except for localhost', async () => {
    await write({ workerUrl: 'http://w.example', ingestToken: 't' })
    await expect(loadConfig(path)).rejects.toThrow(/https/)
    await write({ workerUrl: 'http://localhost:8787', ingestToken: 't' })
    expect((await loadConfig(path)).workerUrl).toBe('http://localhost:8787')
    await write({ workerUrl: 'http://127.0.0.1:8787', ingestToken: 't' })
    expect((await loadConfig(path)).workerUrl).toBe('http://127.0.0.1:8787')
  })

  it('rejects unknown providers in disabled', async () => {
    await write({ workerUrl: 'https://w.example', ingestToken: 't', disabled: ['nope'] })
    await expect(loadConfig(path)).rejects.toThrow(/nope/)
    await write({ workerUrl: 'https://w.example', ingestToken: 't', disabled: ['cursor'] })
    expect((await loadConfig(path)).disabled).toEqual(['cursor'])
  })
})
