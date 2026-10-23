import { Hono } from 'hono'
import { Repo } from './db.js'
import type { Env } from './env.js'
import { processReadings } from './pipeline.js'
import { parseIngestBody } from './validate.js'

const app = new Hono<{ Bindings: Env }>()

async function tokenMatches(header: string | undefined, expected: string): Promise<boolean> {
  if (!expected || !header?.startsWith('Bearer ')) return false
  const digest = (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  const [a, b] = await Promise.all([digest(header.slice('Bearer '.length)), digest(expected)])
  return crypto.subtle.timingSafeEqual(a, b)
}

app.get('/health', (c) => c.text('ok'))

app.post('/ingest', async (c) => {
  if (!(await tokenMatches(c.req.header('authorization'), c.env.INGEST_TOKEN))) return c.body(null, 401)
  const body = parseIngestBody(await c.req.json().catch(() => undefined))
  if (body === null) return c.body(null, 400)
  const repo = new Repo(c.env.DB, c.env.CREDENTIALS_KEY)
  for (const cred of body.credentials) await repo.putCredential(cred.provider, cred.value)
  await processReadings(c.env, body.readings, new Date())
  return c.body(null, 204)
})

export default {
  fetch: app.fetch,
  async scheduled(): Promise<void> {},
} satisfies ExportedHandler<Env>
