import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copilotDeviceFlow, loginProvider, main, type LoginDeps } from '../src/login.ts'

const cfg = { workerUrl: 'https://vigia.example.workers.dev', ingestToken: 'tok', disabled: [] }
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const codexAuth = JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r' } })

let home: string
let out: string[]
let err: string[]
let posts: { url: string; body: any }[]

function deps(over: Partial<LoginDeps> = {}): LoginDeps {
  return {
    home,
    env: {},
    cfg,
    sleep: async () => {},
    log: (m) => out.push(m),
    logError: (m) => err.push(m),
    fetch: (async (url: string, init?: RequestInit) => {
      posts.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined })
      return new Response(null, { status: 204 })
    }) as typeof fetch,
    runInteractive: async () => 0,
    prompt: async () => 'secret-value',
    secretTool: async () => ({ code: 0, stdout: 'ghu_token\n', stderr: '' }),
    ...over,
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'vigia-login-'))
  out = []
  err = []
  posts = []
})
afterEach(() => rm(home, { recursive: true, force: true }))

const credentialPosts = () => posts.filter((p) => p.url.endsWith('/ingest'))

describe('codex', () => {
  it('creates CODEX_HOME with mode 700, runs the device login and keeps auth.json on the laptop', async () => {
    const run = vi.fn(async (_c: string, _a: string[], env: NodeJS.ProcessEnv) => {
      expect((await stat(env.CODEX_HOME!)).mode & 0o777).toBe(0o700)
      await writeFile(join(env.CODEX_HOME!, 'auth.json'), codexAuth)
      return 0
    })
    await loginProvider('codex', deps({ runInteractive: run }))
    expect(run.mock.calls[0]!.slice(0, 2)).toEqual(['codex', ['login', '--device-auth']])
    expect(run.mock.calls[0]![2].CODEX_HOME).toBe(join(home, '.vigia', 'codex'))
    expect(credentialPosts()).toHaveLength(0)
    expect(out.join('\n')).toContain('Codex queda configurado en el portátil')
  })

  it('fails when the login exits non-zero', async () => {
    await expect(loginProvider('codex', deps({ runInteractive: async () => 1 }))).rejects.toThrow(/codex/)
    expect(posts).toHaveLength(0)
  })

  it('fails with a hint when the CLI is not installed', async () => {
    const run = async () => {
      throw Object.assign(new Error('spawn'), { code: 'ENOENT' })
    }
    await expect(loginProvider('codex', deps({ runInteractive: run }))).rejects.toThrow(/no está instalado/)
  })
})

describe('grok', () => {
  it('skips the login when a valid auth.json exists', async () => {
    await mkdir(join(home, '.vigia', 'grok'), { recursive: true })
    await writeFile(join(home, '.vigia', 'grok', 'auth.json'), JSON.stringify({ 'https://auth.x.ai::x': { key: 'k' } }))
    const run = vi.fn(async () => 0)
    await loginProvider('grok', deps({ runInteractive: run }))
    expect(run).not.toHaveBeenCalled()
    expect(credentialPosts()).toHaveLength(1)
  })

  it('runs grok login with GROK_HOME otherwise', async () => {
    const run = vi.fn(async (_c: string, _a: string[], env: NodeJS.ProcessEnv) => {
      await writeFile(join(env.GROK_HOME!, 'auth.json'), JSON.stringify({ s: { refresh_token: 'r' } }))
      return 0
    })
    await loginProvider('grok', deps({ runInteractive: run }))
    expect(run.mock.calls[0]!.slice(0, 2)).toEqual(['grok', ['login']])
    expect(credentialPosts()).toHaveLength(1)
  })

  it('ignores an unparsable existing auth.json and logs in', async () => {
    await mkdir(join(home, '.vigia', 'grok'), { recursive: true })
    await writeFile(join(home, '.vigia', 'grok', 'auth.json'), 'garbage')
    const run = vi.fn(async (_c: string, _a: string[], env: NodeJS.ProcessEnv) => {
      await writeFile(join(env.GROK_HOME!, 'auth.json'), JSON.stringify({ s: { key: 'k' } }))
      return 0
    })
    await loginProvider('grok', deps({ runInteractive: run }))
    expect(run).toHaveBeenCalled()
  })
})

describe('copilotDeviceFlow', () => {
  const start = { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 }

  it('prints the code, polls honoring pending and slow_down, returns the token', async () => {
    const responses = [json(start), json({ error: 'authorization_pending' }), json({ error: 'slow_down' }), json({ access_token: 'ghu_x' })]
    const calls: { url: string; body: string }[] = []
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) })
      return responses.shift()!
    }) as unknown as typeof fetch
    const sleeps: number[] = []
    const token = await copilotDeviceFlow({ fetch: f, sleep: async (ms) => void sleeps.push(ms), log: (m) => out.push(m) })
    expect(token).toBe('ghu_x')
    expect(sleeps).toEqual([5000, 5000, 10000])
    expect(out.join('\n')).toContain('Abre https://github.com/login/device e introduce el código ABCD-1234')
    expect(calls[0]!.url).toBe('https://github.com/login/device/code')
    expect(calls[0]!.body).toContain('client_id=Iv1.b507a08c87ecfe98')
    expect(calls[0]!.body).toContain('scope=read%3Auser')
    expect(calls[1]!.url).toBe('https://github.com/login/oauth/access_token')
    expect(calls[1]!.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code')
    expect(calls[1]!.body).toContain('device_code=dc')
  })

  it.each(['expired_token', 'access_denied'])('fails on %s', async (error) => {
    const responses = [json(start), json({ error })]
    const f = (async () => responses.shift()!) as unknown as typeof fetch
    await expect(copilotDeviceFlow({ fetch: f, sleep: async () => {}, log: () => {} })).rejects.toThrow()
  })

  it('fails when GitHub rejects the device code request', async () => {
    const f = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch
    await expect(copilotDeviceFlow({ fetch: f, sleep: async () => {}, log: () => {} })).rejects.toThrow(/500/)
  })
})

describe('copilot', () => {
  it('uploads the access token and never prints it', async () => {
    const responses = [
      json({ device_code: 'dc', user_code: 'U', verification_uri: 'https://github.com/login/device', interval: 1 }),
      json({ access_token: 'ghu_secret' }),
    ]
    const real = deps().fetch!
    const f = (async (url: string, init: RequestInit) => (String(url).includes('github.com') ? responses.shift()! : real(url, init))) as unknown as typeof fetch
    await loginProvider('copilot', deps({ fetch: f }))
    expect(credentialPosts()[0]!.body.credentials).toEqual([{ provider: 'copilot', value: 'ghu_secret' }])
    expect(out.join('\n')).not.toContain('ghu_secret')
  })
})

describe('freebuff', () => {
  it('looks the token up by the credentials path and uploads it', async () => {
    const st = vi.fn(async () => ({ code: 0, stdout: 'tok123\n', stderr: '' }))
    await loginProvider('freebuff', deps({ secretTool: st }))
    expect(st).toHaveBeenCalledWith('secret-tool', ['lookup', 'service', 'freebuff-cli', 'account', join(home, '.config', 'manicode', 'credentials.json')], expect.anything())
    expect(credentialPosts()[0]!.body.credentials).toEqual([{ provider: 'freebuff', value: 'tok123' }])
  })

  it('honors FREEBUFF_CONFIG_DIR', async () => {
    const st = vi.fn(async (_c: string, _a: string[], _e: NodeJS.ProcessEnv) => ({ code: 0, stdout: 'tok', stderr: '' }))
    await loginProvider('freebuff', deps({ secretTool: st, env: { FREEBUFF_CONFIG_DIR: '/cfg/fb' } }))
    expect(st.mock.calls[0]![1]).toContain('/cfg/fb/credentials.json')
  })

  it('extracts authToken from a JSON secret', async () => {
    const st = async () => ({ code: 0, stdout: JSON.stringify({ authToken: 'jt' }), stderr: '' })
    await loginProvider('freebuff', deps({ secretTool: st }))
    expect(credentialPosts()[0]!.body.credentials[0].value).toBe('jt')
  })

  it('asks to install libsecret-tools on ENOENT', async () => {
    const st = async () => {
      throw Object.assign(new Error('x'), { code: 'ENOENT' })
    }
    await expect(loginProvider('freebuff', deps({ secretTool: st }))).rejects.toThrow(/libsecret-tools/)
  })

  it('asks to log in when nothing is stored', async () => {
    const st = async () => ({ code: 1, stdout: '', stderr: '' })
    await expect(loginProvider('freebuff', deps({ secretTool: st }))).rejects.toThrow('Inicia sesión en Freebuff (ejecuta freebuff) y vuelve a probar')
  })
})

describe('kilo and qoder', () => {
  it('prompts for the kilo key and uploads it', async () => {
    const prompt = vi.fn(async () => ' kilo-key ')
    await loginProvider('kilo', deps({ prompt }))
    expect(prompt).toHaveBeenCalledWith('Copia tu API key de https://app.kilo.ai/profile y pégala aquí:')
    expect(credentialPosts()[0]!.body.credentials).toEqual([{ provider: 'kilo', value: 'kilo-key' }])
    expect(out.join('\n')).not.toContain('kilo-key')
  })

  it('prompts for the qoder PAT', async () => {
    const prompt = vi.fn(async () => 'pat-1')
    await loginProvider('qoder', deps({ prompt }))
    expect(prompt).toHaveBeenCalledWith('Crea un Personal Access Token en https://qoder.com/account/integrations y pégalo aquí:')
    expect(credentialPosts()[0]!.body.credentials[0].value).toBe('{"pat":"pat-1"}')
  })

  it('rejects an empty answer', async () => {
    await expect(loginProvider('kilo', deps({ prompt: async () => '  ' }))).rejects.toThrow(/vacía/)
    expect(posts).toHaveLength(0)
  })
})

describe('main', () => {
  it('prints usage with the six ids when no id or an unknown id is given', async () => {
    expect(await main([], deps())).toBe(1)
    expect(await main(['nope'], deps())).toBe(1)
    expect(err[0]).toMatch(/copilot.*codex.*grok.*freebuff.*kilo.*qoder/)
    expect(posts).toHaveLength(0)
  })

  it('returns 0 for a single successful login', async () => {
    expect(await main(['kilo'], deps())).toBe(0)
  })

  it('returns 1 and reports the error for a failing login', async () => {
    expect(await main(['freebuff'], deps({ secretTool: async () => ({ code: 1, stdout: '', stderr: '' }) }))).toBe(1)
    expect(err.join('\n')).toContain('Inicia sesión en Freebuff')
  })

  it('runs all in order, continues after failures and prints a summary', async () => {
    const order: string[] = []
    const run = async (cmd: string, _a: string[], env: NodeJS.ProcessEnv) => {
      order.push(cmd)
      if (cmd === 'codex') await writeFile(join(env.CODEX_HOME!, 'auth.json'), codexAuth)
      else return 1
      return 0
    }
    const responses = [
      json({ device_code: 'd', user_code: 'U', verification_uri: 'https://github.com/login/device', interval: 0 }),
      json({ access_token: 'ghu' }),
    ]
    const real = deps().fetch!
    const f = (async (url: string, init: RequestInit) => (String(url).includes('github.com') ? responses.shift()! : real(url, init))) as unknown as typeof fetch
    const code = await main(['all'], deps({ runInteractive: run, fetch: f, secretTool: async () => ({ code: 1, stdout: '', stderr: '' }) }))
    expect(code).toBe(1)
    expect(order).toEqual(['codex', 'grok'])
    expect(credentialPosts().map((p) => p.body.credentials[0].provider)).toEqual(['copilot', 'kilo', 'qoder'])
    const text = [...out, ...err].join('\n')
    expect(text).toMatch(/Resumen/)
    expect(text).toMatch(/grok/)
    expect(text).toMatch(/freebuff/)
  })
})
