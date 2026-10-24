export interface Env {
  DB: D1Database
  CREDENTIALS_KEY: string
  INGEST_TOKEN: string
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_CHAT_ID: string
  TELEGRAM_WEBHOOK_SECRET: string
  ACCESS_TEAM_DOMAIN: string
  ACCESS_AUD: string
  CONFIG_JSON?: string
}
