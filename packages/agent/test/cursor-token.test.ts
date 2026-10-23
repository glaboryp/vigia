import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readCursorToken } from '../src/cursor-token.ts'

let dir: string
let tmpRoot: string
let dbPath: string
let savedTmp: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vigia-cursordb-'))
  tmpRoot = join(dir, 'tmp')
  await mkdir(tmpRoot)
  dbPath = join(dir, 'state.vscdb')
  savedTmp = process.env.TMPDIR
  process.env.TMPDIR = tmpRoot
})
afterEach(async () => {
  if (savedTmp === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = savedTmp
  await rm(dir, { recursive: true, force: true })
})

function makeDb(rows: Record<string, string>, wal = false): DatabaseSync {
  const db = new DatabaseSync(dbPath)
  if (wal) db.exec('PRAGMA journal_mode=WAL')
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
  const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
  for (const [k, v] of Object.entries(rows)) insert.run(k, v)
  return db
}

describe('readCursorToken', () => {
  it('reads the access token', async () => {
    makeDb({ 'cursorAuth/accessToken': 'abc.def.ghi', other: 'x' }).close()
    expect(await readCursorToken(dbPath)).toBe('abc.def.ghi')
  })

  it('unwraps a JSON-quoted value', async () => {
    makeDb({ 'cursorAuth/accessToken': '"abc.def.ghi"' }).close()
    expect(await readCursorToken(dbPath)).toBe('abc.def.ghi')
  })

  it('returns null when the key is missing or empty', async () => {
    makeDb({ other: 'x' }).close()
    expect(await readCursorToken(dbPath)).toBeNull()
    await rm(dbPath)
    makeDb({ 'cursorAuth/accessToken': '' }).close()
    expect(await readCursorToken(dbPath)).toBeNull()
  })

  it('returns null when Cursor is not installed', async () => {
    expect(await readCursorToken(join(dir, 'nope.vscdb'))).toBeNull()
  })

  it('sees data that only lives in the -wal file, without touching the original', async () => {
    const db = makeDb({}, true)
    db.exec('PRAGMA wal_autocheckpoint=0')
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('cursorAuth/accessToken', 'from-wal')
    expect(await readCursorToken(dbPath)).toBe('from-wal')
    db.close()
  })

  it('removes its temp dir on success and on failure', async () => {
    makeDb({ 'cursorAuth/accessToken': 't' }).close()
    await readCursorToken(dbPath)
    expect(await readdir(tmpRoot)).toEqual([])

    await writeFile(dbPath, 'this is not a sqlite database'.repeat(50))
    await expect(readCursorToken(dbPath)).rejects.toThrow()
    expect(await readdir(tmpRoot)).toEqual([])
  })
})
