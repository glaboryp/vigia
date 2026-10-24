import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function withSqliteCopy<T>(dbPath: string, prefix: string, use: (db: DatabaseSync) => T): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  try {
    const target = join(dir, basename(dbPath))
    await copyFile(dbPath, target)
    for (const suffix of ['-wal', '-shm']) {
      if (await exists(dbPath + suffix)) await copyFile(dbPath + suffix, target + suffix)
    }
    const db = new DatabaseSync(target, { readOnly: true })
    try {
      return use(db)
    } finally {
      db.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export { exists }
