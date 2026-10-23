import { env } from 'cloudflare:workers'
import type { Env } from '../src/env.js'

export const TABLES = ['snapshots', 'current_quotas', 'period_closes', 'sent_alerts', 'credentials', 'provider_health', 'leases']

export async function resetDb(): Promise<void> {
  for (const t of TABLES) await env.DB.exec(`DELETE FROM ${t}`)
}

export const testEnv: Env = {
  ...env,
  CREDENTIALS_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  INGEST_TOKEN: 'ingest-secret',
  TELEGRAM_BOT_TOKEN: 'bot-token',
  TELEGRAM_CHAT_ID: '42',
  TELEGRAM_WEBHOOK_SECRET: 'hook-secret',
  ACCESS_TEAM_DOMAIN: 'vigia.cloudflareaccess.com',
  ACCESS_AUD: 'aud',
}

export interface TelegramMock {
  fetch: typeof fetch
  texts: string[]
  requests: { url: string; body: Record<string, unknown> }[]
  status: number
  fail: boolean
}

export function telegramMock(): TelegramMock {
  const mock: TelegramMock = {
    texts: [],
    requests: [],
    status: 200,
    fail: false,
    fetch: async (input, init) => {
      if (mock.fail) throw new TypeError('network down')
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      mock.requests.push({ url: String(input), body })
      if (mock.status >= 200 && mock.status < 300) mock.texts.push(String(body.text))
      return new Response('{}', { status: mock.status })
    },
  }
  return mock
}
