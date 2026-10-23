import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { install, renderService, renderTimer } from '../src/install.ts'

describe('unit rendering', () => {
  const service = renderService({ nodePath: '/opt/node 24/bin/node', agentDir: '/home/g/VigIA/packages/agent' })

  it('is a oneshot with absolute node and tsx and a PATH with ~/.local/bin', () => {
    expect(service).toContain('Type=oneshot')
    expect(service).toContain('WorkingDirectory=/home/g/VigIA/packages/agent')
    expect(service).toContain('ExecStart="/opt/node 24/bin/node" "/home/g/VigIA/packages/agent/node_modules/tsx/dist/cli.mjs" src/main.ts')
    expect(service).toMatch(/Environment="PATH=%h\/\.local\/bin:/)
    expect(service).not.toContain('pnpm')
  })

  it('timer fires 2 min after startup then every 30 min, persistent', () => {
    const timer = renderTimer()
    expect(timer).toContain('OnStartupSec=2min')
    expect(timer).toContain('OnUnitActiveSec=30min')
    expect(timer).toContain('Persistent=true')
    expect(timer).toContain('WantedBy=timers.target')
  })
})

describe('unit escaping', () => {
  it('quotes PATH and doubles % in paths', () => {
    const text = renderService({ nodePath: '/opt/n 24/100%/node', agentDir: '/h/a b/50%' })
    expect(text).toContain('Environment="PATH=%h/.local/bin:/opt/n 24/100%%:')
    expect(text).toContain('WorkingDirectory=/h/a b/50%%')
    expect(text).toContain('ExecStart="/opt/n 24/100%%/node" "/h/a b/50%%/node_modules/tsx/dist/cli.mjs" src/main.ts')
  })
})

describe('install', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vigia-install-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))
  const opts = { nodePath: '/n/node', agentDir: '/a', unitDir: undefined as string | undefined }

  it('dry run prints both units and touches nothing', async () => {
    const run = vi.fn()
    const out: string[] = []
    await install({ ...opts, unitDir: join(dir, 'units'), dryRun: true, run, log: (m) => out.push(m) })
    expect(run).not.toHaveBeenCalled()
    expect(out.join('\n')).toContain('Type=oneshot')
    expect(out.join('\n')).toContain('OnUnitActiveSec=30min')
    await expect(readFile(join(dir, 'units', 'vigia-agent.service'))).rejects.toThrow()
  })

  it('writes units and enables the timer', async () => {
    const run = vi.fn(async () => {})
    await install({ ...opts, unitDir: join(dir, 'units'), run, log: () => {} })
    expect(await readFile(join(dir, 'units', 'vigia-agent.service'), 'utf8')).toBe(renderService(opts))
    expect(await readFile(join(dir, 'units', 'vigia-agent.timer'), 'utf8')).toBe(renderTimer())
    expect(run.mock.calls).toEqual([
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', 'vigia-agent.timer']],
    ])
  })
})
