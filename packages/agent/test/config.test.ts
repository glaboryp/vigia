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
})
