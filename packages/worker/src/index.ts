import type { JWTVerifyGetKey } from 'jose'
import { DEFAULT_SURPLUS_CONFIG, findSurplus } from 'core'
import { Hono } from 'hono'
import { verifyAccess } from './access.js'
import { secretMatches } from './auth.js'
import { parseConfig, runScheduled, type CronDeps } from './cron.js'
import { Repo } from './db.js'
import type { Env } from './env.js'
import { processReadings } from './pipeline.js'
import { renderStatusPage } from './status-page.js'
import { handleUpdate } from './telegram.js'
import { parseIngestBody } from './validate.js'

export function createWorker(deps: CronDeps & { jwks?: JWTVerifyGetKey } = {}) {
  const app = new Hono<{ Bindings: Env }>()

  app.get('/health', (c) => c.text('ok'))

  app.get('/', async (c) => {
    if (!(await verifyAccess(c.req.raw, c.env, deps.jwks ? { jwks: deps.jwks } : {}))) {
      return c.text('Acceso denegado', 403)
    }
    const repo = new Repo(c.env.DB, c.env.CREDENTIALS_KEY)
    const [quotas, health, closes] = await Promise.all([repo.getCurrentQuotas(), repo.getHealth(), repo.getPeriodCloses()])
    const config = { ...DEFAULT_SURPLUS_CONFIG, ...parseConfig(c.env.CONFIG_JSON).surplus }
    const html = renderStatusPage({ quotas, health, closes, surplus: findSurplus(closes, config), now: new Date() })
    return c.html(html, 200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' })
  })

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
