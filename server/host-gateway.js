import { randomUUID } from 'node:crypto'
import { DEFAULTS } from '../shared/constants.js'

/**
 * One SSE connection per installation, independent of any session. The board
 * uses it to ask a host to stream a file it holds; mail still flows over the
 * per-session gateways.
 */
export class HostGateway {
  /**
   * @param {{ heartbeatMs?: number, probeTimeoutMs?: number, logger?: { warn: (message: string) => void } }} [options]
   */
  constructor(options = {}) {
    this.heartbeatMs = options.heartbeatMs ?? DEFAULTS.heartbeatMs
    this.probeTimeoutMs = options.probeTimeoutMs ?? 1500
    this.logger = options.logger ?? console
    /** @type {Map<string, Set<import('node:http').ServerResponse>>} */
    this.connections = new Map()
    /** @type {Map<string, { installationId: string, resolve: (result: any) => void, timer: NodeJS.Timeout }>} */
    this.probes = new Map()
    this.heartbeat = setInterval(() => this.beat(), this.heartbeatMs)
    this.heartbeat.unref?.()
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} installationId
   */
  attach(req, res, installationId) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(`event: welcome\ndata: ${JSON.stringify({ type: 'welcome' })}\n\n`)
    // Every DSH process on a host shares one store and one installation id, so
    // several connections may coexist; the board picks the first live one.
    let set = this.connections.get(installationId)
    if (set === undefined) {
      set = new Set()
      this.connections.set(installationId, set)
    }
    set.add(res)
    const close = () => {
      const current = this.connections.get(installationId)
      if (current === undefined) return
      current.delete(res)
      if (current.size === 0) this.connections.delete(installationId)
    }
    req.on('close', close)
    res.on('close', close)
  }

  /** @param {string} installationId */
  isOnline(installationId) {
    const set = this.connections.get(installationId)
    if (set === undefined) return false
    for (const res of set) {
      if (!res.writableEnded && !res.destroyed) return true
    }
    return false
  }

  /**
   * @param {string} installationId
   * @param {string} event
   * @param {unknown} payload
   * @returns {boolean} whether the frame was written
   */
  send(installationId, event, payload) {
    const set = this.connections.get(installationId)
    if (set === undefined) return false
    for (const res of set) {
      if (res.writableEnded || res.destroyed) continue
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
      return true
    }
    return false
  }

  /**
   * Ask one online host whether it actually holds a declared blob. The answer
   * is advisory: an offline host or a timeout is reported as not checked, so a
   * host that is still starting can accept the declaration later.
   * @param {string} installationId
   * @param {string} sha256
   * @param {number} size
   * @returns {Promise<{ checked: boolean, ok: boolean, code?: string, timedOut?: boolean }>}
   */
  async probe(installationId, sha256, size) {
    if (!this.isOnline(installationId)) return { checked: false, ok: true, code: 'OFFLINE' }
    const probeId = randomUUID()
    const { promise, resolve } = Promise.withResolvers()
    const timer = setTimeout(() => {
      if (!this.probes.has(probeId)) return
      this.probes.delete(probeId)
      resolve({ checked: false, ok: true, code: 'TIMEOUT', timedOut: true })
    }, this.probeTimeoutMs)
    timer.unref?.()
    this.probes.set(probeId, { installationId, resolve, timer })
    const sent = this.send(installationId, 'probe', { type: 'probe', probeId, sha256, size })
    if (!sent) {
      clearTimeout(timer)
      this.probes.delete(probeId)
      resolve({ checked: false, ok: true, code: 'OFFLINE' })
    }
    return promise
  }

  /**
   * @param {string} probeId
   * @param {string} installationId
   * @param {{ ok: boolean, code?: string }} result
   * @returns {boolean} whether the probe was pending
   */
  settleProbe(probeId, installationId, result) {
    const pending = this.probes.get(probeId)
    if (pending === undefined || pending.installationId !== installationId) return false
    this.probes.delete(probeId)
    clearTimeout(pending.timer)
    pending.resolve({ checked: true, ok: result.ok === true, code: result.code })
    return true
  }

  beat() {
    for (const set of this.connections.values()) {
      for (const res of set) {
        if (res.writableEnded || res.destroyed) continue
        res.write(': ping\n\n')
      }
    }
  }

  close() {
    clearInterval(this.heartbeat)
    for (const pending of this.probes.values()) {
      clearTimeout(pending.timer)
      pending.resolve({ checked: false, ok: true, code: 'SERVER_CLOSED' })
    }
    this.probes.clear()
    for (const set of this.connections.values()) {
      for (const res of set) {
        try {
          res.end()
        } catch {
          // Already closed.
        }
      }
    }
    this.connections.clear()
  }
}
