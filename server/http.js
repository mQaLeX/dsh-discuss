import { createServer } from 'node:http'
import { DEFAULTS, PROTOCOL_VERSION } from '../shared/constants.js'
import { DiscussError, toErrorBody } from '../shared/errors.js'
import { codePointLength } from '../shared/ids.js'
import { prepare, tx } from './db.js'
import {
  ackMail,
  addHolder,
  dashboardData,
  ensureSession,
  insertMessage,
  listAllTopics,
  listHistory,
  listHolders,
  listTopics,
  loadMessage,
  loadThread,
  messageView,
  prepareMessage,
  pruneMailbox,
  removeHolder,
  setSessionActive,
  setSubscription,
} from './store.js'
import { Gateway } from './gateway.js'
import { HostGateway } from './host-gateway.js'
import { Relay } from './relay.js'
import { renderDashboard } from './dashboard.js'

/** Acks accepted in one request; anything older is simply re-sent. */
const MAX_ACK_BATCH = 1000
const BODY_LIMIT = 8 * 1024 * 1024

/** Sliding-window write limiter shared by posts, comments and uploads. */
export class RateLimiter {
  /**
   * @param {{ limit: number, windowMs: number }} options
   */
  constructor(options) {
    this.limit = options.limit
    this.windowMs = options.windowMs
    /** @type {Map<string, number[]>} */
    this.hits = new Map()
  }

  /**
   * Record one write attempt.
   * @param {string} key
   * @returns {{ allowed: true } | { allowed: false, retryAfterMs: number }}
   */
  take(key) {
    const timestamp = Date.now()
    const recent = (this.hits.get(key) ?? []).filter(hit => timestamp - hit < this.windowMs)
    if (recent.length >= this.limit) {
      const retryAfterMs = Math.max(1, this.windowMs - (timestamp - recent[0]))
      this.hits.set(key, recent)
      return { allowed: false, retryAfterMs }
    }
    recent.push(timestamp)
    this.hits.set(key, recent)
    if (this.hits.size > 10_000) {
      for (const [entryKey, entry] of this.hits) {
        if (entry.length === 0 || timestamp - entry[entry.length - 1] >= this.windowMs) this.hits.delete(entryKey)
      }
    }
    return { allowed: true }
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
/**
 * Resolve once the response can take more bytes again, or once it is gone.
 * @param {import('node:http').ServerResponse} res
 */
function drained(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
  })
}

/**
 * Write one NDJSON export row by row, waiting for the socket instead of
 * buffering the whole topic in memory.
 * @param {import('node:http').ServerResponse} res
 * @param {Iterable<any>} rows
 */
async function writeNdjson(res, rows) {
  for (const row of rows) {
    if (res.writableEnded || res.destroyed) return
    if (!res.write(`${JSON.stringify(messageView(row))}\n`)) await drained(res)
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Record<string, any>>}
 */
async function readJson(req, limit = BODY_LIMIT) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new DiscussError('FILE_TOO_LARGE', 'request body is too large', { status: 413 })
    chunks.push(chunk)
  }
  if (total === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('body must be a JSON object')
    }
    return value
  } catch (error) {
    throw new DiscussError('CONTENT_EMPTY', `body is not valid JSON: ${String(error)}`)
  }
}

/**
 * @param {Record<string, any>} body
 * @returns {{ installationId: string, sessionId: string }}
 */
function requireIds(body) {
  const installationId = body.installationId
  const sessionId = body.sessionId
  if (typeof installationId !== 'string' || installationId.length === 0 || installationId.length > 200) {
    throw new DiscussError('CONTENT_EMPTY', 'installationId is required')
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200) {
    throw new DiscussError('CONTENT_EMPTY', 'sessionId is required')
  }
  return { installationId, sessionId }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} max
 * @param {Record<string, any>} config
 * @returns {string}
 */
function requireContent(value, name, max, config) {
  if (typeof value !== 'string') throw new DiscussError('CONTENT_EMPTY', `${name} is required`)
  const text = value.trim()
  if (text.length === 0) throw new DiscussError('CONTENT_EMPTY', `${name} must not be empty`)
  if (codePointLength(text) > max) {
    throw new DiscussError('CONTENT_TOO_LONG', `${name} exceeds ${max} characters`, {
      details: { max, actual: codePointLength(text) },
    })
  }
  return text
}

/**
 * @param {Record<string, any>} body
 * @returns {string}
 */
function requireRequestId(body) {
  if (typeof body.requestId !== 'string' || body.requestId.length === 0 || body.requestId.length > 200) {
    throw new DiscussError('CONTENT_EMPTY', 'requestId is required')
  }
  return body.requestId
}

/**
 * Build the discuss server around one database.
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   config?: Record<string, any>,
 *   logger?: { warn: (message: string) => void },
 * }} options
 * @returns {{ server: import('node:http').Server, gateway: Gateway, config: Record<string, any>, close: () => Promise<void> }}
 */
export function createDiscussServer(options) {
  const logger = options.logger ?? console
  const config = {
    contentMax: DEFAULTS.contentMax,
    ratePerMinute: DEFAULTS.ratePerMinute,
    rateWindowMs: DEFAULTS.rateWindowMs,
    fileMaxBytes: DEFAULTS.fileMaxBytes,
    relayStartTimeoutMs: DEFAULTS.relayStartTimeoutMs,
    relayMaxConcurrent: DEFAULTS.relayMaxConcurrent,
    retryAfterMs: DEFAULTS.retryAfterMs,
    heartbeatMs: DEFAULTS.heartbeatMs,
    ...options.config,
  }
  const db = options.db
  const gateway = new Gateway(db, {
    retryAfterMs: config.retryAfterMs,
    heartbeatMs: config.heartbeatMs,
    logger,
  })
  const hostGateway = new HostGateway({ heartbeatMs: config.heartbeatMs, logger })
  const relay = new Relay({ hostGateway, config, logger })
  const limiter = new RateLimiter({ limit: config.ratePerMinute, windowMs: config.rateWindowMs })
  pruneMailbox(db)
  const pruneTimer = setInterval(() => {
    try {
      pruneMailbox(db)
    } catch (error) {
      logger.warn(`dsh-discuss: mailbox prune failed: ${String(error)}`)
    }
  }, 60 * 60 * 1000)
  pruneTimer.unref?.()

  /**
   * @param {{ installationId: string, sessionId: string }} ids
   * @param {string} topicId
   */
  function requireSubscribed(ids, topicId) {
    const topic = prepare(db, 'SELECT id FROM topics WHERE id = ?').get(topicId)
    if (topic === undefined) throw new DiscussError('TOPIC_NOT_FOUND', `topic "${topicId}" does not exist`)
    const subscription = prepare(db, `SELECT 1 AS ok FROM subscriptions
      WHERE topic_id = ? AND installation_id = ? AND session_id = ?`)
      .get(topicId, ids.installationId, ids.sessionId)
    if (subscription === undefined) throw new DiscussError('NOT_SUBSCRIBED', 'this session is not subscribed to that topic')
  }

  /**
   * @param {{ installationId: string, sessionId: string }} ids
   */
  function takeWriteSlot(ids) {
    const slot = limiter.take(`${ids.installationId}\u0000${ids.sessionId}`)
    if (!slot.allowed) {
      throw new DiscussError('RATE_LIMITED', 'too many writes from this session', {
        retryable: true,
        retryAfterSeconds: Math.max(1, Math.ceil(slot.retryAfterMs / 1000)),
      })
    }
  }

  /** @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const path = url.pathname

    if (path === '/' || path === '/dashboard') {
      const html = renderDashboard()
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) })
      res.end(html)
      return
    }
    if (path === '/dashboard/api' && req.method === 'GET') {
      const requested = url.searchParams.get('topic')
      const topicId = requested === null || requested === '' ? undefined : requested
      sendJson(res, 200, dashboardData(db, { topicId }))
      return
    }
    if (path === '/healthz') {
      sendJson(res, 200, { ok: true, protocol: PROTOCOL_VERSION })
      return
    }

    if (path === '/v1/register' && req.method === 'POST') {
      const body = await readJson(req)
      const ids = requireIds(body)
      const displayName = typeof body.displayName === 'string' ? body.displayName.slice(0, 200) : undefined
      const session = ensureSession(db, ids, displayName)
      sendJson(res, 200, {
        ok: true,
        username: session.username,
        protocol: PROTOCOL_VERSION,
        limits: {
          contentMax: config.contentMax,
          ratePerMinute: config.ratePerMinute,
          fileMaxBytes: config.fileMaxBytes,
        },
      })
      return
    }

    if (path === '/v1/unregister' && req.method === 'POST') {
      const body = await readJson(req)
      const ids = requireIds(body)
      setSessionActive(db, ids, false)
      gateway.release(ids)
      sendJson(res, 200, { ok: true })
      return
    }

    if (path === '/v1/topics' && req.method === 'GET') {
      const ids = {
        installationId: url.searchParams.get('installationId') ?? '',
        sessionId: url.searchParams.get('sessionId') ?? '',
      }
      requireIds(ids)
      ensureSession(db, ids, undefined)
      sendJson(res, 200, { ok: true, ...listTopics(db, ids) })
      return
    }

    if (path === '/v1/subscriptions' && req.method === 'PUT') {
      const body = await readJson(req)
      const ids = requireIds(body)
      if (typeof body.topicId !== 'string' || body.topicId.length === 0) {
        throw new DiscussError('TOPIC_NOT_FOUND', 'topicId is required')
      }
      if (typeof body.subscribed !== 'boolean') {
        throw new DiscussError('CONTENT_EMPTY', 'subscribed must be a boolean')
      }
      ensureSession(db, ids, undefined)
      tx(db, () => setSubscription(db, ids, body.topicId, body.subscribed))
      sendJson(res, 200, { ok: true })
      return
    }

    if (path === '/v1/messages' && req.method === 'POST') {
      const body = await readJson(req)
      const ids = requireIds(body)
      const topicId = requireString(body, 'topicId')
      const requestId = requireRequestId(body)
      const kind = body.kind === 'comment' ? 'comment' : body.kind === 'post' ? 'post' : undefined
      if (kind === undefined) throw new DiscussError('CONTENT_EMPTY', 'kind must be "post" or "comment"')
      const text = requireContent(body.text, 'content', config.contentMax, config)
      ensureSession(db, ids, undefined)
      const result = tx(db, () => {
        const prepared = prepareMessage(db, {
          ids, topicId, kind, parentId: body.parentId ?? null, requestId, at: body.at,
        })
        // An idempotent replay must not spend the session's write budget.
        if (prepared.duplicate) return { id: prepared.id, duplicate: true, recipients: [] }
        takeWriteSlot(ids)
        return insertMessage(db, prepared, { text, file: null })
      })
      gateway.notify(result.recipients)
      sendJson(res, 200, { ok: true, id: result.id, duplicate: result.duplicate })
      return
    }

    if (path === '/v1/messages/file' && req.method === 'POST') {
      const body = await readJson(req)
      const ids = requireIds(body)
      const topicId = requireString(body, 'topicId')
      const requestId = requireRequestId(body)
      const kind = body.kind === 'comment' ? 'comment' : body.kind === 'post' ? 'post' : undefined
      if (kind === undefined) throw new DiscussError('CONTENT_EMPTY', 'kind must be "post" or "comment"')
      const intro = requireContent(body.intro, 'file intro', config.contentMax, config)
      if (typeof body.fileSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.fileSha256)) {
        throw new DiscussError('CONTENT_EMPTY', 'fileSha256 must be a lowercase hex sha256')
      }
      if (!Number.isSafeInteger(body.fileSize) || body.fileSize <= 0) {
        throw new DiscussError('CONTENT_EMPTY', 'fileSize must be a positive integer')
      }
      if (body.fileSize > config.fileMaxBytes) {
        throw new DiscussError('FILE_TOO_LARGE', `file exceeds ${config.fileMaxBytes} bytes`, {
          details: { max: config.fileMaxBytes, actual: body.fileSize },
        })
      }
      ensureSession(db, ids, undefined)
      const file = { sha256: body.fileSha256, size: body.fileSize }
      // An idempotent replay is answered before the holder probe: the probe
      // guards a new write, and a stored message can outlive its blob.
      const replay = prepareMessage(db, {
        ids, topicId, kind, parentId: body.parentId ?? null, requestId, at: body.at, file,
      })
      if (replay.duplicate) {
        if (replay.reason === 'comment') {
          throw new DiscussError('COMMENT_EXISTS',
            'this session already replied to that message; a file reply would be a second comment', {
            details: { existingId: replay.id, topicId, messageId: body.parentId ?? null },
          })
        }
        sendJson(res, 200, { ok: true, id: replay.id, duplicate: true })
        return
      }
      // Ask an online author host to confirm it actually holds the blob. A
      // negative answer rejects the message; offline or silent hosts are
      // accepted because they can still serve it after reconnecting.
      const probe = await hostGateway.probe(ids.installationId, body.fileSha256, body.fileSize)
      if (probe.checked && probe.ok === false) {
        throw new DiscussError('FILE_NOT_HELD', 'the author host does not hold the declared file', {
          details: { sha256: body.fileSha256, size: body.fileSize, code: probe.code },
        })
      }
      const result = tx(db, () => {
        const prepared = prepareMessage(db, {
          ids, topicId, kind, parentId: body.parentId ?? null, requestId, at: body.at, file,
        })
        if (prepared.duplicate) {
          // A file reply lands as a comment; the one-comment-per-parent rule
          // would silently drop it behind an earlier text reply, so say so.
          if (prepared.reason === 'comment') {
            throw new DiscussError('COMMENT_EXISTS',
              'this session already replied to that message; a file reply would be a second comment', {
                details: { existingId: prepared.id, topicId, messageId: body.parentId ?? null },
              })
          }
          // An idempotent replay must not spend the session's write budget.
          return { id: prepared.id, duplicate: true, recipients: [] }
        }
        takeWriteSlot(ids)
        return insertMessage(db, prepared, { text: intro, file })
      })
      gateway.notify(result.recipients)
      sendJson(res, 200, { ok: true, id: result.id, duplicate: result.duplicate })
      return
    }

    if (path === '/v1/holders' && req.method === 'POST') {
      const body = await readJson(req)
      const ids = requireIds(body)
      const topicId = requireString(body, 'topicId')
      const messageId = Number(body.messageId)
      if (!Number.isSafeInteger(messageId) || messageId <= 0) {
        throw new DiscussError('MESSAGE_NOT_FOUND', 'messageId must be a positive integer')
      }
      requireSubscribed(ids, topicId)
      ensureSession(db, ids, undefined)
      tx(db, () => addHolder(db, topicId, messageId, ids.installationId))
      sendJson(res, 200, { ok: true })
      return
    }

    if (path === '/v1/holders/remove' && req.method === 'POST') {
      const body = await readJson(req)
      const ids = requireIds(body)
      const topicId = requireString(body, 'topicId')
      const messageId = Number(body.messageId)
      if (!Number.isSafeInteger(messageId) || messageId <= 0) {
        throw new DiscussError('MESSAGE_NOT_FOUND', 'messageId must be a positive integer')
      }
      removeHolder(db, topicId, messageId, ids.installationId)
      sendJson(res, 200, { ok: true })
      return
    }

    if (path === '/v1/host-gateway' && req.method === 'GET') {
      const installationId = url.searchParams.get('installationId') ?? ''
      if (installationId.length === 0 || installationId.length > 200) {
        throw new DiscussError('CONTENT_EMPTY', 'installationId is required')
      }
      hostGateway.attach(req, res, installationId)
      return
    }

    if (path.startsWith('/v1/host-probe/') && req.method === 'POST') {
      const probeId = decodeURIComponent(path.slice('/v1/host-probe/'.length))
      const body = await readJson(req)
      const installationId = typeof body.installationId === 'string' ? body.installationId : ''
      if (installationId.length === 0) throw new DiscussError('CONTENT_EMPTY', 'installationId is required')
      hostGateway.settleProbe(probeId, installationId, {
        ok: body.ok === true,
        code: typeof body.code === 'string' ? body.code : undefined,
      })
      sendJson(res, 200, { ok: true })
      return
    }

    if (path.startsWith('/v1/relay/') && req.method === 'POST') {
      const parts = path.slice('/v1/relay/'.length).split('/')
      const transferId = decodeURIComponent(parts[0] ?? '')
      const installationId = url.searchParams.get('installationId') ?? ''
      if (parts[1] === 'fail') {
        const body = await readJson(req)
        relay.fail(transferId, installationId, typeof body.code === 'string' ? body.code : 'TRANSFER_FAILED', res)
        return
      }
      relay.accept(transferId, installationId, req, res)
      return
    }

    if (path === '/v1/ack' && req.method === 'POST') {
      const body = await readJson(req)
      const ids = requireIds(body)
      const mailIds = Array.isArray(body.mailIds) ? body.mailIds.slice(0, MAX_ACK_BATCH) : []
      const changed = mailIds.length === 0 ? 0 : tx(db, () => ackMail(db, ids, mailIds))
      sendJson(res, 200, { ok: true, acked: changed })
      return
    }

    if (path === '/v1/gateway' && req.method === 'GET') {
      const ids = {
        installationId: url.searchParams.get('installationId') ?? '',
        sessionId: url.searchParams.get('sessionId') ?? '',
      }
      requireIds(ids)
      gateway.attach(req, res, ids)
      return
    }

    if (path.startsWith('/v1/history/') && req.method === 'GET') {
      const topicId = decodeURIComponent(path.slice('/v1/history/'.length))
      const ids = {
        installationId: url.searchParams.get('installationId') ?? '',
        sessionId: url.searchParams.get('sessionId') ?? '',
      }
      requireIds(ids)
      requireSubscribed(ids, topicId)
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' })
      await writeNdjson(res, listHistory(db, topicId))
      res.end()
      return
    }

    if (path.startsWith('/v1/query/') && req.method === 'GET') {
      const rest = path.slice('/v1/query/'.length).split('/')
      const topicId = decodeURIComponent(rest[0] ?? '')
      const messageId = Number(rest[1])
      const ids = {
        installationId: url.searchParams.get('installationId') ?? '',
        sessionId: url.searchParams.get('sessionId') ?? '',
      }
      requireIds(ids)
      requireSubscribed(ids, topicId)
      if (!Number.isSafeInteger(messageId) || messageId <= 0) {
        throw new DiscussError('MESSAGE_NOT_FOUND', 'message id must be a positive integer')
      }
      const rows = loadThread(db, topicId, messageId)
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' })
      await writeNdjson(res, rows)
      res.end()
      return
    }

    if (path.startsWith('/v1/files/') && req.method === 'GET') {
      const rest = path.slice('/v1/files/'.length).split('/')
      const topicId = decodeURIComponent(rest[0] ?? '')
      const messageId = Number(rest[1])
      const ids = {
        installationId: url.searchParams.get('installationId') ?? '',
        sessionId: url.searchParams.get('sessionId') ?? '',
      }
      requireIds(ids)
      requireSubscribed(ids, topicId)
      const message = loadMessage(db, topicId, messageId)
      if (message === undefined) throw new DiscussError('MESSAGE_NOT_FOUND', `message "${messageId}" does not exist`)
      if (message.file_sha256 === null) throw new DiscussError('NO_ATTACHMENT', 'that message has no attachment')
      await relay.serve(req, res, {
        topicId,
        messageId,
        message,
        holderIds: listHolders(db, topicId, messageId),
      })
      return
    }

    throw new DiscussError('TOPIC_NOT_FOUND', `no route for ${req.method} ${path}`, { status: 404 })
  }

  const server = createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch((error) => {
      const { body, status } = toErrorBody(error)
      if (res.headersSent) {
        res.end()
        return
      }
      const retryAfter = body.error?.retryAfterSeconds
      if (typeof retryAfter === 'number') res.setHeader('Retry-After', String(retryAfter))
      sendJson(res, status, body)
    })
  })

  return {
    server,
    gateway,
    config,
    async close() {
      clearInterval(pruneTimer)
      gateway.close()
      hostGateway.close()
      relay.close()
      await new Promise((resolve) => {
        server.close(resolve)
        // Release idle keep-alive sockets so shutdown does not wait on them.
        server.closeAllConnections?.()
      })
    },
  }
}

/**
 * @param {Record<string, any>} body
 * @param {string} name
 * @returns {string}
 */
function requireString(body, name) {
  const value = body[name]
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new DiscussError('CONTENT_EMPTY', `${name} is required`)
  }
  return value
}

export { listAllTopics }
