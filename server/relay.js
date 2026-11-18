import { createHash, randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DEFAULTS } from '../shared/constants.js'
import { DiscussError } from '../shared/errors.js'

/**
 * Streams one declared file from an online holder to a requester without
 * storing bytes on the board. The GET handler awaits {@link serve}; the
 * holder's `POST /v1/relay/{id}` hands its request stream over.
 */
export class Relay {
  /**
   * @param {{
   *   hostGateway: import('./host-gateway.js').HostGateway,
   *   config?: Record<string, any>,
   *   logger?: { warn: (message: string) => void },
   * }} options
   */
  constructor(options) {
    this.hostGateway = options.hostGateway
    this.logger = options.logger ?? console
    this.startTimeoutMs = options.config?.relayStartTimeoutMs ?? DEFAULTS.relayStartTimeoutMs
    this.maxConcurrent = options.config?.relayMaxConcurrent ?? DEFAULTS.relayMaxConcurrent
    /** @type {Map<string, any>} */
    this.attempts = new Map()
    this.active = 0
  }

  /**
   * Answer one file request by relaying from the first holder that starts.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{ topicId: string, messageId: number, message: any, holderIds: string[] }} request
   */
  async serve(req, res, { topicId, messageId, message, holderIds }) {
    if (this.active >= this.maxConcurrent) {
      throw new DiscussError('TRANSFER_FAILED', 'too many concurrent transfers', { retryable: true })
    }
    const online = holderIds.filter(id => this.hostGateway.isOnline(id))
    if (online.length === 0) {
      throw new DiscussError('FILE_UNAVAILABLE', 'no online holder for this file', { retryable: true })
    }
    this.active += 1
    let cancelled = false
    let current
    const onClose = () => {
      cancelled = true
      // Wake the pending waiter now: an aborted request must not hold one of
      // the relay slots for the whole start timeout.
      current?.cancel()
    }
    res.on('close', onClose)
    try {
      for (const holder of online) {
        if (cancelled) return
        const attempt = this.#create(holder, message)
        current = attempt
        this.attempts.set(attempt.transferId, attempt)
        this.hostGateway.send(holder, 'fetch', {
          type: 'fetch',
          transferId: attempt.transferId,
          topicId,
          messageId,
          sha256: message.file_sha256,
          size: message.file_size,
        })
        const outcome = await attempt.ready
        if (outcome === 'cancelled') {
          this.attempts.delete(attempt.transferId)
          this.hostGateway.send(holder, 'cancel', { type: 'cancel', transferId: attempt.transferId })
          return
        }
        if (outcome === 'started') {
          clearTimeout(attempt.timer)
          if (cancelled) {
            try {
              attempt.stream?.destroy()
            } catch {
              // The holder stream is already gone.
            }
            this.#ack(attempt, 499)
            this.attempts.delete(attempt.transferId)
            return
          }
          await this.#pipe(attempt, res)
          return
        }
        this.attempts.delete(attempt.transferId)
        this.hostGateway.send(holder, 'cancel', { type: 'cancel', transferId: attempt.transferId })
      }
      if (!cancelled) {
        throw new DiscussError('FILE_UNAVAILABLE', 'no online holder could serve the file', { retryable: true })
      }
    } finally {
      res.off('close', onClose)
      this.active -= 1
    }
  }

  /**
   * @param {string} holder
   * @param {any} message
   */
  #create(holder, message) {
    const transferId = randomUUID()
    const { promise, resolve } = Promise.withResolvers()
    const attempt = {
      transferId,
      holder,
      message,
      ready: promise,
      resolve,
      state: 'waiting',
      stream: undefined,
    }
    attempt.cancel = () => {
      if (attempt.state !== 'waiting') return
      attempt.state = 'cancelled'
      clearTimeout(attempt.timer)
      attempt.resolve('cancelled')
    }
    attempt.timer = setTimeout(() => {
      if (attempt.state !== 'waiting') return
      attempt.state = 'timeout'
      attempt.resolve('timeout')
    }, this.startTimeoutMs)
    attempt.timer.unref?.()
    return attempt
  }

  /**
   * The holder started uploading. Its request stream is piped to the requester.
   * @param {string} transferId
   * @param {string} installationId
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {boolean}
   */
  accept(transferId, installationId, req, res) {
    const attempt = this.attempts.get(transferId)
    if (attempt === undefined || attempt.holder !== installationId || attempt.state !== 'waiting') {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: { code: 'TRANSFER_FAILED', message: 'unknown transfer', retryable: false } }))
      return false
    }
    attempt.state = 'started'
    attempt.stream = req
    // Answer only after the stream settles: responding while the holder is
    // still uploading makes some HTTP clients abort the request body.
    attempt.ack = res
    clearTimeout(attempt.timer)
    attempt.resolve('started')
    return true
  }

  /**
   * The holder cannot serve this file; the next holder is tried.
   * @param {string} transferId
   * @param {string} installationId
   * @param {string} code
   * @param {import('node:http').ServerResponse} res
   * @returns {boolean}
   */
  fail(transferId, installationId, code, res) {
    const attempt = this.attempts.get(transferId)
    if (attempt === undefined || attempt.holder !== installationId || attempt.state !== 'waiting') {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: { code: 'TRANSFER_FAILED', message: 'unknown transfer', retryable: false } }))
      return false
    }
    attempt.state = 'failed'
    attempt.code = code
    clearTimeout(attempt.timer)
    attempt.resolve('failed')
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('ok')
    return true
  }

  /**
   * @param {any} attempt
   * @param {import('node:http').ServerResponse} res
   */
  async #pipe(attempt, res) {
    const message = attempt.message
    const expected = message.file_sha256
    const size = message.file_size ?? 0
    /** @type {Record<string, string | number>} */
    const headers = { 'Content-Type': 'application/octet-stream' }
    if (size > 0) headers['Content-Length'] = size
    if (typeof expected === 'string') headers['X-Content-SHA256'] = expected
    res.writeHead(200, headers)

    const hash = createHash('sha256')
    let bytes = 0
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        if (size > 0 && bytes > size) {
          callback(new Error('relay exceeded the declared size'))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    const cancel = () => {
      try {
        attempt.stream.destroy()
      } catch {
        // The holder stream is already gone.
      }
    }
    res.on('close', cancel)
    try {
      await pipeline(attempt.stream, meter, res)
    } catch (error) {
      this.logger.warn(`dsh-discuss: relay ${attempt.transferId} failed: ${String(error)}`)
      res.destroy()
    } finally {
      res.off('close', cancel)
      this.attempts.delete(attempt.transferId)
      this.#ack(attempt, 200)
      if (typeof expected === 'string' && bytes > 0) {
        const digest = hash.digest('hex')
        if (digest !== expected) {
          this.logger.warn(`dsh-discuss: relay ${attempt.transferId} hash mismatch after ${bytes} bytes`)
        }
      }
    }
  }

  /**
   * @param {any} attempt
   * @param {number} status
   */
  #ack(attempt, status) {
    try {
      if (attempt.ack !== undefined && !attempt.ack.headersSent) {
        attempt.ack.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
        attempt.ack.end(status === 200 ? 'ok' : 'cancelled')
      }
    } catch {
      // The holder connection is gone; nothing left to acknowledge.
    }
  }

  close() {
    for (const attempt of this.attempts.values()) {
      clearTimeout(attempt.timer)
      attempt.state = 'closed'
      attempt.resolve('timeout')
      try {
        attempt.stream?.destroy()
      } catch {
        // Already gone.
      }
    }
    this.attempts.clear()
  }
}
