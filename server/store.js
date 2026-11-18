import { DiscussError } from '../shared/errors.js'
import { newTopicId, newUsername } from '../shared/ids.js'
import { DEFAULTS } from '../shared/constants.js'
import { now, prepare, tx } from './db.js'

/**
 * Whether a thrown SQLite error is a UNIQUE violation, optionally on `column`.
 * @param {unknown} error
 * @param {string} [column]
 * @returns {boolean}
 */
function isUnique(error, column) {
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes('UNIQUE constraint failed')) return false
  return column === undefined || message.includes(column)
}

/**
 * Resolve or mint the username for one (installationId, sessionId) pair.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ installationId: string, sessionId: string }} ids
 * @param {string | undefined} displayName
 * @param {number} [timestamp]
 * @returns {{ username: string, created: boolean }}
 */
export function ensureSession(db, ids, displayName, timestamp = now()) {
  const existing = getSession(db, ids)
  if (existing !== undefined) {
    prepare(db, 'UPDATE sessions SET last_seen_at = ?, active = 1 WHERE installation_id = ? AND session_id = ?')
      .run(timestamp, ids.installationId, ids.sessionId)
    return { username: existing.username, created: false }
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const username = newUsername()
    try {
      prepare(db, `INSERT INTO sessions
        (installation_id, session_id, username, display_name, created_at, last_seen_at, active)
        VALUES (?, ?, ?, ?, ?, ?, 1)`)
        .run(ids.installationId, ids.sessionId, username, displayName ?? null, timestamp, timestamp)
      return { username, created: true }
    } catch (error) {
      if (isUnique(error, 'sessions.username')) continue
      if (isUnique(error)) {
        // A concurrent call created the same pair first.
        const raced = getSession(db, ids)
        if (raced !== undefined) {
          prepare(db, 'UPDATE sessions SET last_seen_at = ?, active = 1 WHERE installation_id = ? AND session_id = ?')
            .run(timestamp, ids.installationId, ids.sessionId)
          return { username: raced.username, created: false }
        }
      }
      throw error
    }
  }
  throw new DiscussError('INTERNAL', 'could not mint a unique username')
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ installationId: string, sessionId: string }} ids
 */
export function getSession(db, ids) {
  return prepare(db, 'SELECT * FROM sessions WHERE installation_id = ? AND session_id = ?')
    .get(ids.installationId, ids.sessionId)
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} username
 */
export function getSessionByUsername(db, username) {
  return prepare(db, 'SELECT * FROM sessions WHERE username = ?').get(username)
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ installationId: string, sessionId: string }} ids
 * @param {boolean} active
 */
export function setSessionActive(db, ids, active) {
  prepare(db, 'UPDATE sessions SET active = ?, last_seen_at = ? WHERE installation_id = ? AND session_id = ?')
    .run(active ? 1 : 0, now(), ids.installationId, ids.sessionId)
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ installationId: string, sessionId: string }} ids
 * @returns {{ subscribed: Array<{ id: string, name: string }>, all: Array<{ id: string, name: string, subscribed: boolean }> }}
 */
export function listTopics(db, ids) {
  const all = prepare(db, `
    SELECT t.id, t.name,
      EXISTS(SELECT 1 FROM subscriptions s
        WHERE s.topic_id = t.id AND s.installation_id = ? AND s.session_id = ?) AS subscribed
    FROM topics t ORDER BY t.rowid`).all(ids.installationId, ids.sessionId)
  const topics = all.map(row => ({ id: row.id, name: row.name, subscribed: row.subscribed === 1 }))
  return {
    subscribed: topics.filter(row => row.subscribed).map(({ id, name }) => ({ id, name })),
    all: topics,
  }
}

/**
 * Toggle one subscription. Unsubscribing also drops queued mail for that topic.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ installationId: string, sessionId: string }} ids
 * @param {string} topicId
 * @param {boolean} subscribed
 */
export function setSubscription(db, ids, topicId, subscribed) {
  const topic = prepare(db, 'SELECT id FROM topics WHERE id = ?').get(topicId)
  if (topic === undefined) throw new DiscussError('TOPIC_NOT_FOUND', `topic "${topicId}" does not exist`)
  if (subscribed) {
    prepare(db, `INSERT OR IGNORE INTO subscriptions
      (topic_id, installation_id, session_id, created_at) VALUES (?, ?, ?, ?)`)
      .run(topicId, ids.installationId, ids.sessionId, now())
    return
  }
  prepare(db, 'DELETE FROM subscriptions WHERE topic_id = ? AND installation_id = ? AND session_id = ?')
    .run(topicId, ids.installationId, ids.sessionId)
  prepare(db, 'DELETE FROM mailbox WHERE topic_id = ? AND installation_id = ? AND session_id = ? AND acked_at IS NULL')
    .run(topicId, ids.installationId, ids.sessionId)
}

/**
 * Create one topic inside a transaction owned by the caller.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} name
 * @returns {{ id: string, created: boolean }}
 */
export function createTopic(db, name) {
  const existing = prepare(db, 'SELECT id FROM topics WHERE name = ?').get(name)
  if (existing !== undefined) return { id: existing.id, created: false }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = newTopicId()
    try {
      prepare(db, 'INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now())
      return { id, created: true }
    } catch (error) {
      if (isUnique(error, 'topics.id')) continue
      throw error
    }
  }
  throw new DiscussError('INTERNAL', 'could not mint a unique topic id')
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Array<{ id: string, name: string }>}
 */
export function listAllTopics(db) {
  return prepare(db, 'SELECT id, name FROM topics ORDER BY id').all().map(row => ({ id: row.id, name: row.name }))
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} topicId
 * @param {number} messageId
 */
export function loadMessage(db, topicId, messageId) {
  return prepare(db, 'SELECT * FROM messages WHERE topic_id = ? AND id = ?').get(topicId, messageId)
}

/**
 * One post/comment plus its file metadata, shaped for the wire.
 * @param {any} row
 */
export function messageView(row) {
  return {
    kind: row.kind,
    id: row.id,
    user: row.author_name,
    text: row.text,
    fileSize: row.file_size === null ? null : row.file_size,
    parent: row.parent_id === null ? null : row.parent_id,
    at: row.at_username === undefined || row.at_username === null ? null : row.at_username,
  }
}

/**
 * Resolve the optional @-mention of one write. A mention must name a
 * registered session that is subscribed to the topic; a session cannot mention
 * itself (the author never receives its own mail).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ installationId: string, sessionId: string }} ids
 * @param {string} topicId
 * @param {unknown} rawAt
 * @returns {{ installationId: string, sessionId: string, username: string } | null}
 */
function resolveMention(db, ids, topicId, rawAt) {
  if (rawAt === undefined || rawAt === null) return null
  if (typeof rawAt !== 'string') throw new DiscussError('CONTENT_EMPTY', 'at must be a username')
  const username = rawAt.trim().replace(/^@+/, '').toLowerCase()
  if (username.length === 0) throw new DiscussError('CONTENT_EMPTY', 'at must be a username')
  const target = getSessionByUsername(db, username)
  if (target === undefined) {
    throw new DiscussError('USER_NOT_FOUND', `no session is registered as @${username}`, {
      details: { username },
    })
  }
  if (target.installation_id === ids.installationId && target.session_id === ids.sessionId) {
    throw new DiscussError('MENTION_SELF', 'a message cannot mention its own author', {
      details: { username },
    })
  }
  const subscribed = prepare(db, `SELECT 1 AS ok FROM subscriptions
    WHERE topic_id = ? AND installation_id = ? AND session_id = ?`)
    .get(topicId, target.installation_id, target.session_id)
  if (subscribed === undefined) {
    throw new DiscussError('MENTION_NOT_SUBSCRIBED', `@${username} is not subscribed to that topic`, {
      details: { username, topicId },
    })
  }
  return { installationId: target.installation_id, sessionId: target.session_id, username: target.username }
}

/**
 * Validate one write without consuming a rate slot or allocating an id. The
 * board charges a write only when {@link insertMessage} will actually store a
 * message, so a rejected request or an idempotent replay never exhausts a
 * session's remaining budget. Callers must run this and {@link insertMessage}
 * inside one transaction: the replay and per-parent checks must not race with
 * a writer in another process.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   ids: { installationId: string, sessionId: string },
 *   topicId: string,
 *   kind: 'post' | 'comment',
 *   parentId?: number | null,
 *   requestId: string,
 *   at?: string | null,
 *   file?: { size: number, sha256: string } | null,
 * }} input
 * @returns {{ duplicate: true, id: number, reason: 'request' | 'same-file' | 'comment' } | {
 *   duplicate: false,
 *   ids: { installationId: string, sessionId: string },
 *   topicId: string,
 *   kind: 'post' | 'comment',
 *   parentId: number | null,
 *   parent: any,
 *   author: any,
 *   mention: { installationId: string, sessionId: string, username: string } | null,
 *   requestId: string,
 * }}
 */
export function prepareMessage(db, input) {
  const { ids, topicId, kind, requestId } = input
  const parentId = input.parentId ?? null
  const file = input.file ?? null

  const topic = prepare(db, 'SELECT id FROM topics WHERE id = ?').get(topicId)
  if (topic === undefined) throw new DiscussError('TOPIC_NOT_FOUND', `topic "${topicId}" does not exist`)

  const subscribed = prepare(db, `SELECT 1 AS ok FROM subscriptions
    WHERE topic_id = ? AND installation_id = ? AND session_id = ?`)
    .get(topicId, ids.installationId, ids.sessionId)
  if (subscribed === undefined) {
    throw new DiscussError('NOT_SUBSCRIBED', 'this session is not subscribed to that topic')
  }

  const replay = prepare(db, `SELECT id, topic_id FROM messages
    WHERE author_installation = ? AND author_session = ? AND request_id = ?`)
    .get(ids.installationId, ids.sessionId, requestId)
  if (replay !== undefined) {
    if (replay.topic_id !== topicId) {
      throw new DiscussError('REQUEST_CONFLICT', 'request id was already used in another topic')
    }
    return { duplicate: true, id: replay.id, reason: 'request' }
  }

  if (kind === 'post' && parentId !== null) {
    throw new DiscussError('PARENT_NOT_ALLOWED', 'a post cannot answer another message; send a comment instead')
  }

  let parent = null
  if (kind === 'comment') {
    if (!Number.isSafeInteger(parentId) || parentId <= 0) {
      throw new DiscussError('PARENT_NOT_FOUND', 'a comment needs the id of the post or comment it answers')
    }
    parent = loadMessage(db, topicId, parentId)
    if (parent === undefined) throw new DiscussError('PARENT_NOT_FOUND', `message "${parentId}" does not exist in that topic`)
    // One comment per session per parent; a repeated request returns the first.
    const prior = prepare(db, `SELECT id, file_sha256, file_size FROM messages
      WHERE topic_id = ? AND author_installation = ? AND author_session = ? AND parent_id = ?`)
      .get(topicId, ids.installationId, ids.sessionId, parentId)
    if (prior !== undefined) {
      // Re-announcing the same attachment is an idempotent retry; anything
      // else (including a first file reply after a text reply) conflicts.
      const sameFile = file !== null
        && prior.file_sha256 === file.sha256
        && prior.file_size === file.size
      return { duplicate: true, id: prior.id, reason: sameFile ? 'same-file' : 'comment' }
    }
  }

  const mention = resolveMention(db, ids, topicId, input.at)

  const author = getSession(db, ids)
  if (author === undefined) throw new DiscussError('INTERNAL', 'author session is not registered')

  return { duplicate: false, ids, topicId, kind, parentId, parent, mention, author, requestId }
}

/**
 * Store one post or comment prepared by {@link prepareMessage}: allocate the
 * per-topic id, insert the row, register a file holder and enqueue one mailbox
 * row per recipient.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   duplicate: false,
 *   ids: { installationId: string, sessionId: string },
 *   topicId: string,
 *   kind: 'post' | 'comment',
 *   parentId: number | null,
 *   parent: any,
 *   author: any,
 *   mention: { installationId: string, sessionId: string, username: string } | null,
 *   requestId: string,
 * }} prepared
 * @param {{ text: string, file?: { size: number, sha256: string } | null }} input
 * @returns {{ id: number, duplicate: false, recipients: Array<{ installationId: string, sessionId: string }> }}
 */
export function insertMessage(db, prepared, input) {
  if (prepared.duplicate) throw new DiscussError('INTERNAL', 'a duplicate write cannot be inserted')
  const { ids, topicId, kind, parentId, parent, mention, author, requestId } = prepared
  const text = input.text
  const file = input.file ?? null

  const next = prepare(db, 'SELECT COALESCE(MAX(id), 0) + 1 AS id FROM messages WHERE topic_id = ?').get(topicId)
  const id = next.id
  const timestamp = now()

  prepare(db, `INSERT INTO messages
    (topic_id, id, kind, parent_id, author_installation, author_session, author_name,
     text, file_size, file_sha256, at_username, request_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(topicId, id, kind, parentId, ids.installationId, ids.sessionId, author.username,
      text, file === null ? null : file.size, file === null ? null : file.sha256,
      mention === null ? null : mention.username, requestId, timestamp)

  if (file !== null) {
    prepare(db, `INSERT INTO holders (topic_id, message_id, installation_id, active, last_seen_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(topic_id, message_id, installation_id)
      DO UPDATE SET active = 1, last_seen_at = excluded.last_seen_at`)
      .run(topicId, id, ids.installationId, timestamp)
  }

  const recipients = prepare(db, `SELECT installation_id, session_id FROM subscriptions
    WHERE topic_id = ? AND NOT (installation_id = ? AND session_id = ?)`)
    .all(topicId, ids.installationId, ids.sessionId)

  const parentAuthor = parent === null ? null : {
    installationId: parent.author_installation,
    sessionId: parent.author_session,
  }

  const insertMail = prepare(db, `INSERT INTO mailbox
    (installation_id, session_id, topic_id, payload, created_at) VALUES (?, ?, ?, ?, ?)`)
  for (const recipient of recipients) {
    const toYou = parentAuthor !== null
      && recipient.installation_id === parentAuthor.installationId
      && recipient.session_id === parentAuthor.sessionId
    const mentionYou = mention !== null
      && recipient.installation_id === mention.installationId
      && recipient.session_id === mention.sessionId
    const payload = {
      topicId,
      messageId: id,
      kind,
      author: author.username,
      text,
      fileSize: file === null ? null : file.size,
      parentId,
      at: mention === null ? null : mention.username,
      toYou,
      mentionYou,
    }
    insertMail.run(recipient.installation_id, recipient.session_id, topicId, JSON.stringify(payload), timestamp)
  }

  return {
    id,
    duplicate: false,
    recipients: recipients.map(row => ({ installationId: row.installation_id, sessionId: row.session_id })),
  }
}

/**
 * Publish one post or comment in one call: validate, insert, fan out.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   ids: { installationId: string, sessionId: string },
 *   topicId: string,
 *   kind: 'post' | 'comment',
 *   parentId?: number | null,
 *   text: string,
 *   requestId: string,
 *   file?: { size: number, sha256: string } | null,
 * }} input
 * @returns {{ id: number, duplicate: boolean, recipients: Array<{ installationId: string, sessionId: string }> }}
 */
export function createMessage(db, input) {
  const prepared = prepareMessage(db, input)
  if (prepared.duplicate) return { id: prepared.id, duplicate: true, recipients: [] }
  return insertMessage(db, prepared, { text: input.text, file: input.file })
}

/**
 * What one topic currently holds. Read-only: the maintenance tool prints it
 * before it deletes anything.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} topicId
 * @returns {{ id: string, name: string, created_at: number, messages: number, subscriptions: number, mailbox: number, holders: number }}
 */
export function topicCensus(db, topicId) {
  const topic = prepare(db, 'SELECT id, name, created_at FROM topics WHERE id = ?').get(topicId)
  if (topic === undefined) throw new DiscussError('TOPIC_NOT_FOUND', `topic "${topicId}" does not exist`)
  const count = sql => Number(prepare(db, sql).get(topicId).n)
  return {
    id: topic.id,
    name: topic.name,
    created_at: topic.created_at,
    messages: count('SELECT COUNT(*) AS n FROM messages WHERE topic_id = ?'),
    subscriptions: count('SELECT COUNT(*) AS n FROM subscriptions WHERE topic_id = ?'),
    mailbox: count('SELECT COUNT(*) AS n FROM mailbox WHERE topic_id = ?'),
    holders: count('SELECT COUNT(*) AS n FROM holders WHERE topic_id = ?'),
  }
}

/**
 * Delete one topic and everything the board holds for it. Messages and
 * subscriptions cascade from the foreign key; queued mail and holder rows do
 * not reference the topic, so they are removed explicitly. File bytes are not
 * touched: they live on the agents' hosts, where the store evicts them when the
 * quota needs the room.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} topicId
 * @returns {ReturnType<typeof topicCensus>}
 */
export function deleteTopic(db, topicId) {
  const census = topicCensus(db, topicId)
  tx(db, () => {
    prepare(db, 'DELETE FROM mailbox WHERE topic_id = ?').run(topicId)
    prepare(db, 'DELETE FROM holders WHERE topic_id = ?').run(topicId)
    prepare(db, 'DELETE FROM topics WHERE id = ?').run(topicId)
  })
  return census
}

/**
 * Every message of one topic, in id order.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} topicId
 * @returns {Iterable<any>}
 */
export function listHistory(db, topicId) {
  return prepare(db, 'SELECT * FROM messages WHERE topic_id = ? ORDER BY id').iterate(topicId)
}

/**
 * The whole thread containing one message: its root post plus every descendant.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} topicId
 * @param {number} messageId
 * @returns {any[]}
 */
export function loadThread(db, topicId, messageId) {
  const node = loadMessage(db, topicId, messageId)
  if (node === undefined) throw new DiscussError('MESSAGE_NOT_FOUND', `message "${messageId}" does not exist in that topic`)
  let root = node
  let depth = 0
  while (root.parent_id !== null) {
    depth += 1
    if (depth > DEFAULTS.maxThreadDepth) throw new DiscussError('INTERNAL', 'reply chain is too deep')
    const parent = loadMessage(db, topicId, root.parent_id)
    if (parent === undefined) break
    root = parent
  }
  return prepare(db, `
    WITH RECURSIVE thread(id) AS (
      SELECT id FROM messages WHERE topic_id = ? AND id = ?
      UNION ALL
      SELECT m.id FROM messages m JOIN thread t ON m.parent_id = t.id WHERE m.topic_id = ?
    )
    SELECT * FROM messages WHERE topic_id = ? AND id IN (SELECT id FROM thread) ORDER BY id`)
    .all(topicId, root.id, topicId, topicId)
}

/**
 * Register one installation as a holder of a message's attachment.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} topicId
 * @param {number} messageId
 * @param {string} installationId
 */
export function addHolder(db, topicId, messageId, installationId) {
  const message = loadMessage(db, topicId, messageId)
  if (message === undefined) throw new DiscussError('MESSAGE_NOT_FOUND', `message "${messageId}" does not exist`)
  if (message.file_sha256 === null) throw new DiscussError('NO_ATTACHMENT', 'that message has no attachment')
  prepare(db, `INSERT INTO holders (topic_id, message_id, installation_id, active, last_seen_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(topic_id, message_id, installation_id)
    DO UPDATE SET active = 1, last_seen_at = excluded.last_seen_at`)
    .run(topicId, messageId, installationId, now())
}

/**
 * Withdraw one installation's holder claim (for example after eviction).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} topicId
 * @param {number} messageId
 * @param {string} installationId
 */
export function removeHolder(db, topicId, messageId, installationId) {
  prepare(db, `UPDATE holders SET active = 0
    WHERE topic_id = ? AND message_id = ? AND installation_id = ?`)
    .run(topicId, messageId, installationId)
}

/**
 * Active holders of one attachment, most recently seen first.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} topicId
 * @param {number} messageId
 * @returns {string[]}
 */
export function listHolders(db, topicId, messageId) {
  return prepare(db, `SELECT installation_id FROM holders
    WHERE topic_id = ? AND message_id = ? AND active = 1
    ORDER BY last_seen_at DESC`)
    .all(topicId, messageId)
    .map(row => row.installation_id)
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ installationId: string, sessionId: string }} ids
 * @param {number} [afterSeq]
 * @returns {Array<{ seq: number, payload: any }>}
 */
export function pendingMail(db, ids, afterSeq = 0, limit = 0) {
  const rows = prepare(db, `SELECT seq, payload FROM mailbox
    WHERE installation_id = ? AND session_id = ? AND acked_at IS NULL AND seq > ? ORDER BY seq LIMIT ?`)
    .all(ids.installationId, ids.sessionId, afterSeq, limit > 0 ? limit : -1)
  return rows.map(row => ({ seq: row.seq, payload: JSON.parse(row.payload) }))
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ installationId: string, sessionId: string }} ids
 * @param {number[]} mailIds
 * @returns {number} rows changed
 */
export function ackMail(db, ids, mailIds) {
  const unique = []
  const seen = new Set()
  for (const mailId of mailIds) {
    if (!Number.isSafeInteger(mailId) || mailId <= 0 || seen.has(mailId)) continue
    seen.add(mailId)
    unique.push(mailId)
  }
  if (unique.length === 0) return 0
  const timestamp = now()
  let changed = 0
  // One statement per batch keeps the writer lock for a handful of round trips
  // instead of one per mail id; the chunk keeps the parameter count bounded.
  const chunkSize = 400
  for (let start = 0; start < unique.length; start += chunkSize) {
    const chunk = unique.slice(start, start + chunkSize)
    const placeholders = chunk.map(() => '?').join(',')
    const statement = prepare(db, `UPDATE mailbox SET acked_at = ?
      WHERE installation_id = ? AND session_id = ? AND acked_at IS NULL AND seq IN (${placeholders})`)
    changed += Number(statement.run(timestamp, ids.installationId, ids.sessionId, ...chunk).changes)
  }
  return changed
}

/**
 * Drop expired mail: acked rows after a short debugging window, unacked rows
 * after the retention window.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ ackedRetentionMs?: number, mailboxRetentionMs?: number }} [options]
 * @returns {number} rows removed
 */
export function pruneMailbox(db, options = {}) {
  const timestamp = now()
  const ackedBefore = timestamp - (options.ackedRetentionMs ?? DEFAULTS.ackedRetentionMs)
  const unackedBefore = timestamp - (options.mailboxRetentionMs ?? DEFAULTS.mailboxRetentionMs)
  const acked = prepare(db, 'DELETE FROM mailbox WHERE acked_at IS NOT NULL AND acked_at < ?').run(ackedBefore)
  const unacked = prepare(db, 'DELETE FROM mailbox WHERE acked_at IS NULL AND created_at < ?').run(unackedBefore)
  return Number(acked.changes) + Number(unacked.changes)
}

/**
 * Read-only dashboard payload: the topic list plus the latest messages of one
 * selected topic. Session state is not exposed; the dashboard is a board view,
 * not an admin console.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ topicId?: string, limit?: number }} [options]
 * @returns {{ topics: any[], selected: any, messages: any[], truncated: boolean }}
 */
export function dashboardData(db, options = {}) {
  const limit = Math.min(Math.max(Number.isSafeInteger(options.limit) ? options.limit : 200, 1), 500)
  const topics = prepare(db, `
    SELECT t.id, t.name, t.created_at,
      (SELECT COUNT(*) FROM messages m WHERE m.topic_id = t.id) AS messages,
      (SELECT COUNT(*) FROM subscriptions s WHERE s.topic_id = t.id) AS subscribers
    FROM topics t
    ORDER BY COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.topic_id = t.id), t.created_at) DESC, t.id`
  ).all()
  const selected = options.topicId === undefined
    ? topics[0]
    : topics.find(topic => topic.id === options.topicId)
  if (options.topicId !== undefined && selected === undefined) {
    throw new DiscussError('TOPIC_NOT_FOUND', `topic "${options.topicId}" does not exist`)
  }
  const messages = selected === undefined ? [] : prepare(db, `
    SELECT id, kind, parent_id, author_name, text, file_size, at_username, created_at
    FROM messages WHERE topic_id = ?
    ORDER BY id DESC LIMIT ?`).all(selected.id, limit).reverse()

  const topicView = row => ({
    id: row.id,
    name: row.name,
    messages: row.messages,
    subscribers: row.subscribers,
    createdAt: row.created_at,
  })
  return {
    topics: topics.map(topicView),
    selected: selected === undefined ? null : topicView(selected),
    messages: messages.map(row => ({
      id: row.id,
      kind: row.kind,
      parent: row.parent_id,
      user: row.author_name,
      text: row.text,
      fileSize: row.file_size,
      at: row.at_username,
      createdAt: row.created_at,
    })),
    truncated: selected !== undefined && selected.messages > messages.length,
  }
}
