import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '../src/antigravity.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vigia-run-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function script(name: string, body: string): Promise<string> {
  const file = join(dir, name)
  await writeFile(file, body)
  return file
}

describe('runProcess', () => {
  it('captures output and exit code', async () => {
    const f = await script('ok.mjs', "console.log('hola'); process.exit(3)")
    expect(await runProcess(process.execPath, [f], process.env)).toEqual({ code: 3, stdout: 'hola\n', stderr: '' })
  })

  it('kills the whole process group on timeout and resolves promptly', async () => {
    const f = await script(
      'hang.mjs',
      `import { spawn } from 'node:child_process'
const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })
console.log(g.pid)
setInterval(()=>{},1000)`,
    )
    const started = Date.now()
    const result = await runProcess(process.execPath, [f], process.env, { timeoutMs: 400, graceMs: 1000 })
    expect(Date.now() - started).toBeLessThan(400 + 1000 + 500)
    expect(result.code).toBeNull()
    const grandchild = Number(result.stdout.trim())
    expect(grandchild).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 200))
    expect(alive(grandchild)).toBe(false)
  })

  it('resolves after exit plus grace when a detached grandchild holds stdout open', async () => {
    const f = await script(
      'leak.mjs',
      `import { spawn } from 'node:child_process'
const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{},4000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true })
g.unref()
console.log('listo ' + g.pid)`,
    )
    const started = Date.now()
    const result = await runProcess(process.execPath, [f], process.env, { timeoutMs: 10_000, graceMs: 300 })
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(3000)
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/^listo \d+/)
    process.kill(Number(/\d+/.exec(result.stdout)![0]), 'SIGKILL')
  })
})
