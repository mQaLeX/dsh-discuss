import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { DEFAULTS } from '../shared/constants.js'
import { DiscussError, toErrorBody } from '../shared/errors.js'
import { tx } from './db.js'
import { createTopic, listAllTopics } from './store.js'

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
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
 * @returns {Promise<Record<string, any>>}
 */
async function readJson(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > 1024 * 1024) throw new DiscussError('CONTENT_TOO_LONG', 'request body is too large', { status: 413 })
    chunks.push(chunk)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Admin server: the only writer of `topics`. Requests are strictly serialized
 * through one promise chain, and a single create token may be outstanding.
 * @param {{ db: import('node:sqlite').DatabaseSync, config?: Record<string, any>, logger?: { warn: (m: string) => void } }} options
 * @returns {{ server: import('node:http').Server, close: () => Promise<void>, state: { token: null | { value: string, expiresAt: number } } }}
 */
export function createAdminServer(options) {
  const config = {
    adminTokenTtlMs: DEFAULTS.adminTokenTtlMs,
    ...options.config,
  }
  const db = options.db
  const logger = options.logger ?? console
  /** @type {{ value: string, expiresAt: number } | null} */
  let token = null
  /** @type {Promise<void>} */
  let queue = Promise.resolve()

  function liveToken() {
    if (token === null) return null
    if (Date.now() >= token.expiresAt) {
      token = null
      return null
    }
    return token
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {Record<string, any>} body - request body, read before the queue
   */
  async function handle(req, res, body = {}) {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const path = url.pathname

    if (path === '/healthz') {
      sendJson(res, 200, { ok: true })
      return
    }

    if (path === '/v1/admin/topics' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, topics: listAllTopics(db) })
      return
    }

    if (path === '/v1/admin/topics/request' && req.method === 'POST') {
      if (liveToken() !== null) {
        throw new DiscussError('TOKEN_HELD', 'another create request holds the token', {
          retryable: true,
          retryAfterSeconds: Math.max(1, Math.ceil(((token?.expiresAt ?? Date.now()) - Date.now()) / 1000)),
        })
      }
      token = { value: randomUUID(), expiresAt: Date.now() + config.adminTokenTtlMs }
      sendJson(res, 200, {
        ok: true,
        token: token.value,
        expiresAt: token.expiresAt,
        topics: listAllTopics(db),
      })
      return
    }

    if (path === '/v1/admin/topics/confirm' && req.method === 'POST') {
      const presented = typeof body.token === 'string' ? body.token : ''
      const current = liveToken()
      // Any confirm invalidates the token, whatever happens next.
      token = null
      if (current === null || presented !== current.value) {
        throw new DiscussError('TOKEN_EXPIRED', 'the create token is missing, stale or expired')
      }
      const names = Array.isArray(body.names) ? body.names : null
      if (names === null || names.length === 0 || names.length > 50) {
        throw new DiscussError('CONTENT_EMPTY', 'names must be a non-empty array of at most 50 strings')
      }
      const cleaned = names.map((name) => {
        if (typeof name !== 'string') throw new DiscussError('CONTENT_EMPTY', 'every name must be a string')
        const trimmed = name.trim()
        if (trimmed.length === 0 || trimmed.length > 100) {
          throw new DiscussError('CONTENT_EMPTY', 'every name must contain 1-100 characters')
        }
        return trimmed
      })
      const results = tx(db, () => cleaned.map((name) => {
        const created = createTopic(db, name)
        return { name, id: created.id, status: created.created ? 'created' : 'existing' }
      }))
      sendJson(res, 200, { ok: true, results })
      return
    }

    throw new DiscussError('TOPIC_NOT_FOUND', `no route for ${req.method} ${path}`, { status: 404 })
  }

  /** @param {import('node:http').ServerResponse} res @param {unknown} error */
  function respond(res, error) {
    const { body, status } = toErrorBody(error)
    if (res.headersSent) {
      res.end()
      return
    }
    const retryAfter = body.error?.retryAfterSeconds
    if (typeof retryAfter === 'number') res.setHeader('Retry-After', String(retryAfter))
    sendJson(res, status, body)
  }

  /**
   * Run one handler after the previous one settled. The queue serializes the
   * handlers (the board's single-writer guarantee), never request bodies.
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueue(task) {
    const run = queue.then(task, task)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  const server = createServer((req, res) => {
    // Read the body first: a client that stalls its upload holds its own
    // request only, not the writer slot every other admin call needs.
    const body = req.method === 'POST' ? readJson(req) : Promise.resolve({})
    body
      .then(parsed => enqueue(() => handle(req, res, parsed)))
      .catch((error) => {
        logger.warn(`dsh-discuss-admin: serialized request failed: ${String(error)}`)
        respond(res, error)
      })
  })

  return {
    server,
    close: () => new Promise(resolve => server.close(resolve)),
    state: {
      get token() {
        return token
      },
    },
  }
}
