import { DEFAULTS, PROTOCOL_VERSION } from '../shared/constants.js'
import { pendingMail } from './store.js'

/**
 * SSE delivery hub. One connection per registered session; the client acks
 * each mail id over the HTTP ack endpoint. A session reconnecting receives
 * every unacked row again and dedupes by `mailId`.
 */
export class Gateway {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {{ retryAfterMs?: number, heartbeatMs?: number, logger?: { warn: (m: string) => void } }} [options]
   */
  constructor(db, options = {}) {
    this.db = db
    this.retryAfterMs = options.retryAfterMs ?? DEFAULTS.retryAfterMs
    this.heartbeatMs = options.heartbeatMs ?? DEFAULTS.heartbeatMs
    this.logger = options.logger ?? console
    /** @type {Map<string, { ids: { installationId: string, sessionId: string }, res: import('node:http').ServerResponse, lastSent: number }>} */
    this.connections = new Map()
    /** Rows read and written per flush before yielding to the socket. */
    this.pageSize = options.pageSize ?? 200
    this.retryTimer = setInterval(() => this.retryAll(), this.retryAfterMs)
    this.heartbeatTimer = setInterval(() => this.heartbeatAll(), this.heartbeatMs)
    this.retryTimer.unref?.()
    this.heartbeatTimer.unref?.()
  }

  /** @param {{ installationId: string, sessionId: string }} ids */
  static key(ids) {
    return `${ids.installationId}\u0000${ids.sessionId}`
  }

  /**
   * Accept one SSE connection and send every unacked message for its session.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{ installationId: string, sessionId: string }} ids
   */
  attach(req, res, ids) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const retryAfterSeconds = Math.max(1, Math.ceil(this.retryAfterMs / 1000))
    res.write(`event: welcome\ndata: ${JSON.stringify({ type: 'welcome', protocol: PROTOCOL_VERSION, retryAfterSeconds })}\n\n`)

    const key = Gateway.key(ids)
    const previous = this.connections.get(key)
    if (previous !== undefined && previous.res !== res) {
      try {
        previous.res.end()
      } catch {
        // The old connection is already gone; the new one supersedes it.
      }
    }
    const connection = { ids, res, lastSent: 0 }
    this.connections.set(key, connection)

    const close = () => {
      if (this.connections.get(key) === connection) this.connections.delete(key)
    }
    req.on('close', close)
    res.on('close', close)
    this.flush(connection, 0)
  }

  /**
   * Push new mail to every connected recipient session.
   * @param {Array<{ installationId: string, sessionId: string }>} recipients
   */
  notify(recipients) {
    for (const ids of recipients) {
      const connection = this.connections.get(Gateway.key(ids))
      if (connection !== undefined) this.flush(connection, connection.lastSent)
    }
  }

  /**
   * @param {{ ids: { installationId: string, sessionId: string }, res: import('node:http').ServerResponse, lastSent: number }} connection
   * @param {number} afterSeq
   */
  flush(connection, afterSeq) {
    let cursor = afterSeq
    for (;;) {
      if (connection.res.writableEnded || connection.res.destroyed) return
      let rows
      try {
        rows = pendingMail(this.db, connection.ids, cursor, this.pageSize)
      } catch (error) {
        this.logger.warn(`dsh-discuss: mailbox read failed: ${String(error)}`)
        return
      }
      if (rows.length === 0) return
      for (const row of rows) {
        const frame = {
          type: 'delivery',
          sessionId: connection.ids.sessionId,
          messages: [{ mailId: row.seq, ...row.payload }],
        }
        const buffered = connection.res.write(`event: delivery\ndata: ${JSON.stringify(frame)}\n\n`)
        if (row.seq > connection.lastSent) connection.lastSent = row.seq
        // Backpressure: stop and let the next notify/retry resume, instead of
        // piling the whole backlog into the socket buffer.
        if (!buffered) return
      }
      if (rows.length < this.pageSize) return
      cursor = rows[rows.length - 1].seq
    }
  }

  /** Resend every unacked row; the client dedupes by mail id. */
  retryAll() {
    for (const connection of this.connections.values()) {
      connection.lastSent = 0
      this.flush(connection, 0)
    }
  }

  heartbeatAll() {
    for (const connection of this.connections.values()) {
      if (connection.res.writableEnded || connection.res.destroyed) continue
      connection.res.write(': ping\n\n')
    }
  }

  /**
   * Drop one live connection (used by unregister).
   * @param {{ installationId: string, sessionId: string }} ids
   */
  release(ids) {
    const key = Gateway.key(ids)
    const connection = this.connections.get(key)
    if (connection === undefined) return
    this.connections.delete(key)
    try {
      connection.res.end()
    } catch {
      // Already closed.
    }
  }

  /** Stop the timers and close every stream. */
  close() {
    clearInterval(this.retryTimer)
    clearInterval(this.heartbeatTimer)
    for (const connection of this.connections.values()) {
      try {
        connection.res.end()
      } catch {
        // Already closed.
      }
    }
    this.connections.clear()
  }
}
