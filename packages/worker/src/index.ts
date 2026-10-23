import { Hono } from 'hono'
import { secretMatches } from './auth.js'
import { runScheduled, type CronDeps } from './cron.js'
import { Repo } from './db.js'
import type { Env } from './env.js'
import { processReadings } from './pipeline.js'
import { handleUpdate } from './telegram.js'
import { parseIngestBody } from './validate.js'

export function createWorker(deps: CronDeps = {}) {
  const app = new Hono<{ Bindings: Env }>()

  app.get('/health', (c) => c.text('ok'))

  app.post('/ingest', async (c) => {
    const authorization = c.req.header('authorization')
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
    if (!(await secretMatches(bearer, c.env.INGEST_TOKEN))) return c.body(null, 401)
    const now = new Date()
    const body = parseIngestBody(await c.req.json().catch(() => undefined), now)
    if (body === null) return c.body(null, 400)
    if (!(await processReadings(c.env, body.readings, now, deps))) return c.body(null, 503, { 'Retry-After': '30' })
    const repo = new Repo(c.env.DB, c.env.CREDENTIALS_KEY)
    for (const cred of body.credentials) await repo.putCredential(cred.provider, cred.value)
    return c.body(null, 204)
  })

  app.post('/telegram', async (c) => {
    if (!(await secretMatches(c.req.header('x-telegram-bot-api-secret-token'), c.env.TELEGRAM_WEBHOOK_SECRET))) {
      return c.body(null, 401)
    }
    const update: unknown = await c.req.json().catch(() => undefined)
    c.executionCtx.waitUntil(handleUpdate(c.env, update, new Date(), c.executionCtx, deps).catch((err) => console.error('telegram update failed', err)))
    return c.body(null, 200)
  })

  return {
    fetch: app.fetch,
    async scheduled(controller, env, ctx): Promise<void> {
      ctx.waitUntil(runScheduled(env, new Date(controller.scheduledTime), deps))
    },
  } satisfies ExportedHandler<Env>
}

export default createWorker()
