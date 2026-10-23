import { Hono } from 'hono'
import { runScheduled, type CronDeps } from './cron.js'
import { Repo } from './db.js'
import type { Env } from './env.js'
import { processReadings } from './pipeline.js'
import { parseIngestBody } from './validate.js'

async function tokenMatches(header: string | undefined, expected: string): Promise<boolean> {
  if (!expected || !header?.startsWith('Bearer ')) return false
  const digest = (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  const [a, b] = await Promise.all([digest(header.slice('Bearer '.length)), digest(expected)])
  return crypto.subtle.timingSafeEqual(a, b)
}

export function createWorker(deps: CronDeps = {}) {
  const app = new Hono<{ Bindings: Env }>()

  app.get('/health', (c) => c.text('ok'))

  app.post('/ingest', async (c) => {
    if (!(await tokenMatches(c.req.header('authorization'), c.env.INGEST_TOKEN))) return c.body(null, 401)
    const now = new Date()
    const body = parseIngestBody(await c.req.json().catch(() => undefined), now)
    if (body === null) return c.body(null, 400)
    if (!(await processReadings(c.env, body.readings, now, deps))) return c.body(null, 503, { 'Retry-After': '30' })
    const repo = new Repo(c.env.DB, c.env.CREDENTIALS_KEY)
    for (const cred of body.credentials) await repo.putCredential(cred.provider, cred.value)
    return c.body(null, 204)
  })

  return {
    fetch: app.fetch,
    async scheduled(controller, env, ctx): Promise<void> {
      ctx.waitUntil(runScheduled(env, new Date(controller.scheduledTime), deps))
    },
  } satisfies ExportedHandler<Env>
}

export default createWorker()
