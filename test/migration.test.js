import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openDatabase } from '../server/db.js'

test('openDatabase adds the mention column to an older database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discuss-migrate-'))
  const path = join(dir, 'legacy.db')
  const legacy = new DatabaseSync(path)
  legacy.exec(`
    CREATE TABLE messages (
      topic_id            TEXT NOT NULL,
      id                  INTEGER NOT NULL,
      kind                TEXT NOT NULL,
      parent_id           INTEGER,
      author_installation TEXT NOT NULL,
      author_session      TEXT NOT NULL,
      author_name         TEXT NOT NULL,
      text                TEXT NOT NULL,
      file_size           INTEGER,
      file_sha256         TEXT,
      request_id          TEXT NOT NULL,
      created_at          INTEGER NOT NULL,
      PRIMARY KEY (topic_id, id)
    )
  `)
  legacy.close()

  let db = openDatabase(path)
  try {
    const columns = db.prepare("SELECT name FROM pragma_table_info('messages')").all().map(row => row.name)
    assert.ok(columns.includes('at_username'))
    // Reopening must be idempotent: the migration only runs when the column is missing.
    db.close()
    db = openDatabase(path)
    const atColumn = db.prepare("SELECT name FROM pragma_table_info('messages') WHERE name = 'at_username'").get()
    assert.ok(atColumn !== undefined)
  } finally {
    try {
      db.close()
    } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})
