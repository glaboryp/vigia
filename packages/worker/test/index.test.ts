import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import worker from '../src/index.js'

it('GET /health returns ok', async () => {
  const res = await worker.fetch(new Request('https://vigia.test/health'), env, {} as ExecutionContext)
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('ok')
})
