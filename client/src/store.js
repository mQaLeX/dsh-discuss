import { createHash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULTS } from '../../shared/constants.js'
import { DiscussError } from '../../shared/errors.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  sha256       TEXT PRIMARY KEY,
  size         INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
  topic_id   TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (topic_id, message_id)
);

CREATE INDEX IF NOT EXISTS shares_sha ON shares(sha256);
`

/** @returns {string} */
export function defaultStoreDir() {
  if (process.env.DISCUSS_STORE_DIR) return process.env.DISCUSS_STORE_DIR
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  return join(base, 'dsh-discuss')
}

/** @returns {number} */
function now() {
  return Date.now()
}

/**
 * Per-host content-addressed file store plus the (topic, message) → blob map.
 * Bytes never leave this host except through the relay.
 */
export class FileStore {
  /**
   * @param {{ dir?: string, maxBytes?: number, logger?: { warn: (message: string) => void } }} [options]
   */
  constructor(options = {}) {
    this.dir = options.dir ?? defaultStoreDir()
    this.blobDir = join(this.dir, 'files')
    this.maxBytes = options.maxBytes ?? DEFAULTS.storeMaxBytes
    this.logger = options.logger ?? console
    mkdirSync(this.blobDir, { recursive: true })
    this.db = new DatabaseSync(join(this.dir, 'files.db'))
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(SCHEMA)
  }

  /**
   * Blob path for a content address. Anything that is not a lowercase hex
   * sha256 is rejected here: the address can arrive over the wire, and joining
   * it into a path would let `../` escape the store.
   * @param {string} sha256
   * @returns {string | undefined}
   */
  pathFor(sha256) {
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return undefined
    return join(this.blobDir, sha256)
  }

  /** @param {string} sha256 */
  has(sha256) {
    const path = this.pathFor(sha256)
    return path !== undefined && existsSync(path)
  }

  /**
   * @param {string} sha256
   * @returns {number | undefined}
   */
  sizeOf(sha256) {
    const row = this.db.prepare('SELECT size FROM files WHERE sha256 = ?').get(sha256)
    return row?.size
  }

  /**
   * @param {string} topicId
   * @param {number} messageId
   * @returns {string | undefined}
   */
  shaFor(topicId, messageId) {
    const row = this.db.prepare('SELECT sha256 FROM shares WHERE topic_id = ? AND message_id = ?')
      .get(topicId, messageId)
    return row?.sha256
  }

  /**
   * Path of the blob backing a message, when this host holds it.
   * @param {string} topicId
   * @param {number} messageId
   * @returns {string | undefined}
   */
  pathForMessage(topicId, messageId) {
    const sha = this.shaFor(topicId, messageId)
    return sha !== undefined && this.has(sha) ? this.pathFor(sha) : undefined
  }

  /**
   * @param {string} sha256
   * @param {number} size
   */
  #upsertFile(sha256, size) {
    const timestamp = now()
    this.db.prepare(`INSERT INTO files (sha256, size, created_at, last_used_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET last_used_at = excluded.last_used_at`)
      .run(sha256, size, timestamp, timestamp)
  }

  /** @param {string} sha256 */
  touch(sha256) {
    this.db.prepare('UPDATE files SET last_used_at = ? WHERE sha256 = ?').run(now(), sha256)
  }

  /**
   * Adopt one existing file (already hashed) into the store.
   * @param {string} temporaryPath
   * @param {string} sha256
   * @param {number} size
   */
  adopt(temporaryPath, sha256, size) {
    // A blob that is already stored costs no new space, so quota only applies
    // to the bytes this adopt would actually add.
    const existing = this.pathFor(sha256)
    try {
      if (existing === undefined || !existsSync(existing)) this.#ensureRoom(size)
    } catch (error) {
      try {
        unlinkSync(temporaryPath)
      } catch {
        // The temporary file is already gone.
      }
      throw error
    }
    const target = existing
    if (target === undefined) {
      unlinkSync(temporaryPath)
      throw new DiscussError('CONTENT_EMPTY', 'sha256 must be a lowercase hex digest')
    }
    if (existsSync(target)) {
      unlinkSync(temporaryPath)
    } else {
      renameSync(temporaryPath, target)
    }
    this.#upsertFile(sha256, size)
    this.evict()
    return { sha256, size }
  }

  /**
   * Import bytes already in memory.
   * @param {Uint8Array} bytes
   */
  putBytes(bytes) {
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const target = this.pathFor(sha256)
    if (!existsSync(target)) {
      this.#ensureRoom(bytes.length)
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
      const fd = openSync(temporary, 'w', 0o600)
      try {
        writeSync(fd, bytes)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, target)
    }
    this.#upsertFile(sha256, bytes.length)
    this.evict()
    return { sha256, size: bytes.length }
  }

  /**
   * Stream-import a file through the sandboxed fs seam without buffering it.
   * @param {any} fs
   * @param {any} target
   * @param {number} size
   * @param {{ signal?: AbortSignal, chunkSize?: number }} [options]
   */
  async importFromFs(fs, target, size, options = {}) {
    const chunkSize = options.chunkSize ?? 1024 * 1024
    this.#ensureRoom(size)
    const temporary = join(this.blobDir, `.import-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const fd = openSync(temporary, 'w', 0o600)
    const hash = createHash('sha256')
    try {
      for (let offset = 0; offset < size; offset += chunkSize) {
        const length = Math.min(chunkSize, size - offset)
        const chunk = await fs.readByteRange(target, { offset, length }, options.signal)
        if (chunk.length === 0) break
        hash.update(chunk)
        writeSync(fd, chunk)
      }
      fsyncSync(fd)
    } catch (error) {
      closeSync(fd)
      try {
        unlinkSync(temporary)
      } catch {
        // The temporary file is already gone.
      }
      throw error
    }
    closeSync(fd)
    const sha256 = hash.digest('hex')
    return this.adopt(temporary, sha256, size)
  }

  /**
   * @param {string} topicId
   * @param {number} messageId
   * @param {string} sha256
   */
  link(topicId, messageId, sha256) {
    this.db.prepare(`INSERT INTO shares (topic_id, message_id, sha256, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(topic_id, message_id) DO UPDATE SET sha256 = excluded.sha256`)
      .run(topicId, messageId, sha256, now())
    this.touch(sha256)
  }

  /** @returns {number} */
  totalBytes() {
    const row = this.db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM files').get()
    return row.total
  }

  /**
   * Drop the least recently used blob that no message references.
   * @returns {boolean} whether anything was removed
   */
  #evictOne() {
    const row = this.db.prepare(`SELECT f.sha256 FROM files f
      WHERE NOT EXISTS (SELECT 1 FROM shares s WHERE s.sha256 = f.sha256)
      ORDER BY f.last_used_at ASC LIMIT 1`).get()
    if (row === undefined) return false
    this.db.prepare('DELETE FROM files WHERE sha256 = ?').run(row.sha256)
    try {
      unlinkSync(this.pathFor(row.sha256))
    } catch {
      // Already missing.
    }
    return true
  }

  /** @param {number} incoming */
  #ensureRoom(incoming) {
    while (this.totalBytes() + incoming > this.maxBytes) {
      if (!this.#evictOne()) {
        throw new DiscussError('STORE_FULL', 'the shared file store is full', {
          details: { maxBytes: this.maxBytes },
        })
      }
    }
  }

  /** Trim the store to the quota. */
  evict() {
    try {
      while (this.totalBytes() > this.maxBytes && this.#evictOne()) {
        // Keep evicting until the quota is met.
      }
    } catch (error) {
      this.logger.warn(`dsh-discuss: store eviction failed: ${String(error)}`)
    }
  }

  /** @returns {{ bytes: number, files: number }} */
  stats() {
    const row = this.db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS total FROM files').get()
    return { files: row.files, bytes: row.total }
  }

  close() {
    try {
      this.db.close()
    } catch {
      // Already closed.
    }
  }
}
