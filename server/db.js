import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  installation_id TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  username        TEXT NOT NULL UNIQUE,
  display_name    TEXT,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (installation_id, session_id)
);

CREATE TABLE IF NOT EXISTS topics (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  topic_id        TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (topic_id, installation_id, session_id)
);

CREATE TABLE IF NOT EXISTS messages (
  topic_id            TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  id                  INTEGER NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('post','comment')),
  parent_id           INTEGER,
  author_installation TEXT NOT NULL,
  author_session      TEXT NOT NULL,
  author_name         TEXT NOT NULL,
  text                TEXT NOT NULL,
  file_size           INTEGER,
  file_sha256         TEXT,
  at_username         TEXT,
  request_id          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (topic_id, id),
  UNIQUE (topic_id, author_installation, author_session, parent_id),
  UNIQUE (author_installation, author_session, request_id)
);

CREATE INDEX IF NOT EXISTS messages_parent ON messages(topic_id, parent_id);
CREATE INDEX IF NOT EXISTS messages_created ON messages(topic_id, created_at);

CREATE TABLE IF NOT EXISTS mailbox (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  topic_id        TEXT NOT NULL,
  payload         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  acked_at        INTEGER
);

CREATE TABLE IF NOT EXISTS holders (
  topic_id        TEXT NOT NULL,
  message_id      INTEGER NOT NULL,
  installation_id TEXT NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  last_seen_at    INTEGER NOT NULL,
  PRIMARY KEY (topic_id, message_id, installation_id)
);

CREATE INDEX IF NOT EXISTS holders_message ON holders(topic_id, message_id, active);

CREATE INDEX IF NOT EXISTS mailbox_pending
  ON mailbox(installation_id, session_id, acked_at, seq);

-- The hourly prune deletes by age, not by session; partial indexes keep those
-- two deletes index scans instead of full table scans.
CREATE INDEX IF NOT EXISTS mailbox_acked ON mailbox(acked_at) WHERE acked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS mailbox_unacked ON mailbox(created_at) WHERE acked_at IS NULL;
`

/**
 * Additive migrations for databases created by older builds. Every step must
 * be idempotent: it runs on every open.
 * @param {DatabaseSync} db
 */
function migrate(db) {
  const atColumn = db.prepare(
    "SELECT name FROM pragma_table_info('messages') WHERE name = 'at_username'",
  ).get()
  if (atColumn === undefined) db.exec('ALTER TABLE messages ADD COLUMN at_username TEXT')
}

/**
 * Open (and initialize) one database file or an in-memory database.
 * @param {string} path - file path, or ':memory:'.
 * @returns {DatabaseSync}
 */
/** @type {WeakMap<object, Map<string, any>>} */
const statementCache = new WeakMap()

/**
 * Prepare one statement per connection and SQL text. DatabaseSync is
 * synchronous, so a cached statement is never busy when the next call wants it;
 * parsing the same SQL again is pure overhead on hot paths.
 * @param {any} db
 * @param {string} sql
 * @returns {any}
 */
export function prepare(db, sql) {
  let cache = statementCache.get(db)
  if (cache === undefined) {
    cache = new Map()
    statementCache.set(db, cache)
  }
  let statement = cache.get(sql)
  if (statement === undefined) {
    statement = db.prepare(sql)
    cache.set(sql, statement)
  }
  return statement
}

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/**
 * Run `fn` inside one IMMEDIATE transaction. Writes serialize at the database
 * level, so two processes (discuss + admin) sharing the file never interleave
 * a read-modify-write.
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = fn()
    db.exec('COMMIT')
    return value
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // A failed rollback leaves the transaction closed; the original error wins.
    }
    throw error
  }
}

/** @returns {number} epoch milliseconds */
export function now() {
  return Date.now()
}
