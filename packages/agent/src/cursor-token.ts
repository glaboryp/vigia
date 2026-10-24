import { homedir } from 'node:os'
import { join } from 'node:path'
import { exists, withSqliteCopy } from './sqlite-copy.js'

const TOKEN_KEY = 'cursorAuth/accessToken'

export function defaultCursorDbPath(): string {
  return join(homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

function normalize(value: unknown): string | null {
  let text: string
  if (typeof value === 'string') text = value
  else if (value instanceof Uint8Array) text = Buffer.from(value).toString('utf8')
  else return null
  text = text.trim()
  if (text.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'string') text = parsed.trim()
    } catch {
      return null
    }
  }
  return text === '' ? null : text
}

export async function readCursorToken(dbPath: string = defaultCursorDbPath()): Promise<string | null> {
  if (!(await exists(dbPath))) return null
  return withSqliteCopy(dbPath, 'vigia-cursor-', (db) => {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(TOKEN_KEY) as { value: unknown } | undefined
    return row ? normalize(row.value) : null
  })
}
