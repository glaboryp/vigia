import type { Env } from './env.js'

export async function sendMessage(env: Env, text: string, fetchFn?: typeof fetch): Promise<boolean> {
  const doFetch = fetchFn ?? ((input, init) => fetch(input, init))
  try {
    const res = await doFetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    await res.body?.cancel()
    return res.ok
  } catch {
    return false
  }
}
