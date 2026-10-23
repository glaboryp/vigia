import { Hono } from 'hono'
import type { Env } from './env.js'

const app = new Hono<{ Bindings: Env }>()

app.get('/health', (c) => c.text('ok'))

export default {
  fetch: app.fetch,
  async scheduled(): Promise<void> {},
} satisfies ExportedHandler<Env>
