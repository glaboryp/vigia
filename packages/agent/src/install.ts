import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface UnitPaths {
  nodePath: string
  agentDir: string
}

const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export function renderService({ nodePath, agentDir }: UnitPaths): string {
  const tsx = join(agentDir, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const path = ['%h/.local/bin', dirname(nodePath), '/usr/local/bin', '/usr/bin', '/bin']
  return `[Unit]
Description=VigIA agent (local AI quota readings)

[Service]
Type=oneshot
WorkingDirectory=${agentDir}
Environment=PATH=${path.join(':')}
ExecStart=${quote(nodePath)} ${quote(tsx)} src/main.ts
`
}

export function renderTimer(): string {
  return `[Unit]
Description=Run the VigIA agent periodically

[Timer]
OnStartupSec=2min
OnUnitActiveSec=30min
Persistent=true

[Install]
WantedBy=timers.target
`
}

export type SystemctlRunner = (cmd: string, args: string[]) => Promise<void>

export interface InstallOptions extends UnitPaths {
  unitDir?: string
  dryRun?: boolean
  run?: SystemctlRunner
  log?: (message: string) => void
}

export async function install(opts: InstallOptions): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(m))
  const run = opts.run ?? (async (cmd, args) => void (await execFileAsync(cmd, args)))
  const unitDir = opts.unitDir ?? join(homedir(), '.config', 'systemd', 'user')
  const units = { 'vigia-agent.service': renderService(opts), 'vigia-agent.timer': renderTimer() }
  if (opts.dryRun) {
    for (const [name, text] of Object.entries(units)) log(`# ${join(unitDir, name)}\n${text}`)
    return
  }
  await mkdir(unitDir, { recursive: true })
  for (const [name, text] of Object.entries(units)) await writeFile(join(unitDir, name), text)
  await run('systemctl', ['--user', 'daemon-reload'])
  await run('systemctl', ['--user', 'enable', '--now', 'vigia-agent.timer'])
  log('Temporizador vigia-agent.timer activado')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  install({
    nodePath: process.execPath,
    agentDir: join(dirname(fileURLToPath(import.meta.url)), '..'),
    dryRun: process.argv.includes('--dry-run'),
  }).catch((err) => {
    console.error(`No he podido instalar el servicio: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
