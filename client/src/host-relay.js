import { existsSync, statSync } from 'node:fs'
import { reconnectDelay } from './api.js'

/**
 * Per-host relay worker: keeps one connection to the board's host gateway and
 * streams files this host holds when the board asks. It lives for the whole
 * DSH process, independent of any session.
 */
export class HostRelay {
  /**
   * @param {{ api: any, installationId: string, store: any, logger?: any, maxConcurrent?: number }} options
   */
  constructor(options) {
    this.api = options.api
    this.installationId = options.installationId
    this.store = options.store
    this.logger = options.logger ?? console
    this.maxConcurrent = options.maxConcurrent ?? 4
    this.active = 0
    this.closed = false
    this.abort = new AbortController()
  }

  start() {
    if (this.started) return
    this.started = true
    void this.#loop()
  }

  async #loop() {
    let attempt = 0
    while (!this.closed) {
      try {
        await this.api.hostStream(this.installationId, {
          signal: this.abort.signal,
          onFrame: (frame) => this.#onFrame(frame),
        })
        attempt = 0
      } catch (error) {
        if (this.closed) return
        this.logger.warn?.(`dsh-discuss: host relay connection failed: ${String(error)}`)
      }
      if (this.closed) return
      await this.#delay(reconnectDelay(attempt))
      attempt += 1
    }
  }

  /** @param {any} frame */
  #onFrame(frame) {
    if (frame?.type === 'probe') {
      void this.#probe(frame)
      return
    }
    if (frame?.type !== 'fetch') return
    void this.#serve(frame)
  }

  /** @param {any} frame */
  async #probe(frame) {
    if (this.closed || typeof frame?.probeId !== 'string') return
    let result = { ok: false, code: 'FILE_NOT_FOUND' }
    const local = typeof frame.sha256 === 'string' ? this.store.pathFor(frame.sha256) : undefined
    if (local !== undefined && existsSync(local)) {
      const size = statSync(local).size
      result = typeof frame.size === 'number' && frame.size > 0 && size !== frame.size
        ? { ok: false, code: 'HASH_MISMATCH' }
        : { ok: true }
    }
    try {
      await this.api.hostProbe(frame.probeId, this.installationId, result)
    } catch (error) {
      this.logger.warn?.(`dsh-discuss: host probe reply failed: ${String(error)}`)
    }
  }

  /** @param {any} frame */
  async #serve(frame) {
    if (this.closed) return
    if (this.active >= this.maxConcurrent) {
      await this.#fail(frame.transferId, 'TRANSFER_FAILED')
      return
    }
    const local = this.store.pathForMessage(frame.topicId, frame.messageId)
      ?? (typeof frame.sha256 === 'string' ? this.store.pathFor(frame.sha256) : undefined)
    if (local === undefined || !existsSync(local)) {
      await this.#fail(frame.transferId, 'FILE_NOT_FOUND')
      return
    }
    const size = statSync(local).size
    if (typeof frame.size === 'number' && frame.size > 0 && size !== frame.size) {
      await this.#fail(frame.transferId, 'HASH_MISMATCH')
      return
    }
    this.active += 1
    try {
      await this.api.relayUpload(frame.transferId, this.installationId, local, size)
    } catch (error) {
      this.logger.warn?.(`dsh-discuss: relay upload failed: ${String(error)}`)
    } finally {
      this.active -= 1
    }
  }

  /**
   * @param {string} transferId
   * @param {string} code
   */
  async #fail(transferId, code) {
    try {
      await this.api.relayFail(transferId, this.installationId, code)
    } catch (error) {
      this.logger.warn?.(`dsh-discuss: relay failure report failed: ${String(error)}`)
    }
  }

  /** @param {number} ms */
  #delay(ms) {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        this.abort.signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      timer.unref?.()
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      this.abort.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  close() {
    this.closed = true
    this.abort.abort()
  }
}
