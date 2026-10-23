import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const TOKEN_KEY = 'cursorAuth/accessToken'

export function defaultCursorDbPath(): string {
  return join(homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
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
  const dir = await mkdtemp(join(tmpdir(), 'vigia-cursor-'))
  try {
    const target = join(dir, basename(dbPath))
    await copyFile(dbPath, target)
    for (const suffix of ['-wal', '-shm']) {
      if (await exists(dbPath + suffix)) await copyFile(dbPath + suffix, target + suffix)
    }
    const db = new DatabaseSync(target, { readOnly: true })
    try {
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(TOKEN_KEY) as { value: unknown } | undefined
      return row ? normalize(row.value) : null
    } finally {
      db.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
