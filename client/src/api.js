import { createHash } from 'node:crypto'
import { closeSync, createReadStream, fsyncSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { Readable } from 'node:stream'
import { DEFAULTS } from '../../shared/constants.js'
import { DiscussError } from '../../shared/errors.js'

/**
 * Parse one SSE byte stream into JSON frames.
 * @param {ReadableStream<Uint8Array> | null} body
 * @param {(frame: any) => void} onFrame
 */
async function readSse(body, onFrame) {
  if (body === null) return
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const data = block
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n')
      if (data.length === 0) continue
      try {
        onFrame(JSON.parse(data))
      } catch {
        // A malformed frame is ignored; the server always sends valid JSON.
      }
    }
  }
}

/** HTTP client for the discuss server, shared by every session in the process. */
export class DiscussApi {
  /**
   * @param {{ baseUrl: string, timeoutMs?: number, uploadTimeoutMs?: number, fetchImpl?: typeof fetch, logger?: { warn: (m: string) => void } }} options
   */
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.requestTimeoutMs
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULTS.uploadTimeoutMs
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.logger = options.logger ?? console
  }

  /**
   * @param {string} path
   * @param {{ method?: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal }} [options]
   */
  async request(path, options = {}) {
    const url = new URL(path, this.baseUrl)
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    let response
    try {
      response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new DiscussError('SERVER_UNREACHABLE', `cannot reach ${this.baseUrl}: ${String(error)}`, {
        retryable: true,
        cause: error,
      })
    }
    const text = await response.text()
    let parsed
    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (!response.ok) {
      const error = parsed?.error
      if (error !== undefined) {
        throw new DiscussError(error.code ?? 'INTERNAL', error.message ?? 'server error', {
          retryable: error.retryable === true,
          retryAfterSeconds: error.retryAfterSeconds,
          details: error.details,
          status: response.status,
        })
      }
      throw new DiscussError('INTERNAL', `HTTP ${response.status} from ${path}`, { status: response.status })
    }
    return parsed
  }

  /** @param {{ installationId: string, sessionId: string }} ids */
  register(ids) {
    return this.request('/v1/register', { method: 'POST', body: ids })
  }

  /** @param {{ installationId: string, sessionId: string }} ids */
  unregister(ids) {
    return this.request('/v1/unregister', { method: 'POST', body: ids })
  }

  /** @param {{ installationId: string, sessionId: string }} ids */
  topics(ids) {
    const query = new URLSearchParams({ installationId: ids.installationId, sessionId: ids.sessionId })
    return this.request(`/v1/topics?${query}`)
  }

  /**
   * @param {{ installationId: string, sessionId: string }} ids
   * @param {string} topicId
   * @param {boolean} subscribed
   */
  setSubscription(ids, topicId, subscribed) {
    return this.request('/v1/subscriptions', {
      method: 'PUT',
      body: { ...ids, topicId, subscribed },
    })
  }

  /**
   * @param {{ installationId: string, sessionId: string }} ids
   * @param {{ topicId: string, kind: 'post' | 'comment', parentId?: number, requestId: string, text: string, at?: string }} message
   */
  write(ids, message) {
    return this.request('/v1/messages', { method: 'POST', body: { ...ids, ...message } })
  }

  /**
   * Declare a file that this host holds; the board stores metadata only.
   * @param {{ installationId: string, sessionId: string }} ids
   * @param {{ topicId: string, kind: 'post' | 'comment', parentId?: number, requestId: string, intro: string, fileSha256: string, fileSize: number, at?: string }} message
   */
  shareFile(ids, message) {
    return this.request('/v1/messages/file', {
      method: 'POST',
      body: { ...ids, ...message },
    })
  }

  /**
   * Register this installation as a holder of one message's attachment.
   * @param {{ installationId: string, sessionId: string }} ids
   * @param {string} topicId
   * @param {number} messageId
   */
  addHolder(ids, topicId, messageId) {
    return this.request('/v1/holders', { method: 'POST', body: { ...ids, topicId, messageId } })
  }

  /**
   * @param {{ installationId: string, sessionId: string }} ids
   * @param {string} topicId
   * @param {number} messageId
   */
  removeHolder(ids, topicId, messageId) {
    return this.request('/v1/holders/remove', { method: 'POST', body: { ...ids, topicId, messageId } })
  }

  /**
   * @param {{ installationId: string, sessionId: string }} ids
   * @param {number[]} mailIds
   */
  ack(ids, mailIds) {
    return this.request('/v1/ack', { method: 'POST', body: { ...ids, mailIds } })
  }

  /**
   * Follow the SSE gateway until `signal` aborts.
   * @param {{ installationId: string, sessionId: string }} ids
   * @param {{ signal: AbortSignal, onFrame: (frame: any) => void }} options
   */
  async stream(ids, options) {
    const url = new URL('/v1/gateway', this.baseUrl)
    url.searchParams.set('installationId', ids.installationId)
    url.searchParams.set('sessionId', ids.sessionId)
    let response
    try {
      response = await this.fetchImpl(url, {
        signal: options.signal,
        headers: { Accept: 'text/event-stream' },
      })
    } catch (error) {
      if (options.signal.aborted) throw error
      throw new DiscussError('SERVER_UNREACHABLE', `gateway unreachable: ${String(error)}`, {
        retryable: true,
        cause: error,
      })
    }
    if (!response.ok) {
      throw new DiscussError('SERVER_UNREACHABLE', `gateway HTTP ${response.status}`, {
        retryable: response.status >= 500,
        status: response.status,
      })
    }
    await readSse(response.body, options.onFrame)
  }

  /**
   * @param {{ installationId: string, sessionId: string }} ids
   * @param {string} path - `/v1/history/<topic>` or `/v1/query/<topic>/<id>`
   * @returns {Promise<string>} JSONL text
   */
  async ndjson(ids, path) {
    const query = new URLSearchParams({ installationId: ids.installationId, sessionId: ids.sessionId })
    let response
    try {
      response = await this.fetchImpl(new URL(`${path}?${query}`, this.baseUrl), {
        signal: AbortSignal.timeout(this.timeoutMs * 6),
      })
    } catch (error) {
      throw new DiscussError('SERVER_UNREACHABLE', `cannot reach ${this.baseUrl}: ${String(error)}`, {
        retryable: true,
        cause: error,
      })
    }
    const text = await response.text()
    if (!response.ok) {
      let code = 'INTERNAL'
      let message = `HTTP ${response.status}`
      try {
        const parsed = JSON.parse(text)
        code = parsed?.error?.code ?? code
        message = parsed?.error?.message ?? message
      } catch {}
      throw new DiscussError(code, message, { status: response.status })
    }
    return text
  }

  /**
   * Ask the board to relay one message's attachment into a temporary file.
   * Streams to disk and verifies the declared sha256.
   * @param {{ installationId: string, sessionId: string }} ids
   * @param {string} topicId
   * @param {number} messageId
   * @param {string} temporaryPath
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ sha256: string, size: number }>}
   */
  async requestFile(ids, topicId, messageId, temporaryPath, signal) {
    const query = new URLSearchParams({ installationId: ids.installationId, sessionId: ids.sessionId })
    let response
    try {
      response = await this.fetchImpl(
        new URL(`/v1/files/${encodeURIComponent(topicId)}/${messageId}?${query}`, this.baseUrl),
        { signal: signal ?? AbortSignal.timeout(this.uploadTimeoutMs) },
      )
    } catch (error) {
      throw new DiscussError('SERVER_UNREACHABLE', `cannot reach ${this.baseUrl}: ${String(error)}`, {
        retryable: true,
        cause: error,
      })
    }
    if (!response.ok) {
      let code = 'INTERNAL'
      let message = `HTTP ${response.status}`
      try {
        const parsed = JSON.parse(await response.text())
        code = parsed?.error?.code ?? code
        message = parsed?.error?.message ?? message
      } catch {}
      throw new DiscussError(code, message, { status: response.status })
    }
    const expected = response.headers.get('x-content-sha256')
    const hash = createHash('sha256')
    let bytes = 0
    const fd = openSync(temporaryPath, 'w', 0o600)
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length
        hash.update(chunk)
        writeSync(fd, chunk)
      }
      fsyncSync(fd)
    } catch (error) {
      closeSync(fd)
      this.#discard(temporaryPath)
      throw new DiscussError('TRANSFER_FAILED', `file transfer failed: ${String(error)}`, {
        retryable: true,
        cause: error,
      })
    }
    closeSync(fd)
    const sha256 = hash.digest('hex')
    if (typeof expected === 'string' && expected.length > 0 && sha256 !== expected) {
      this.#discard(temporaryPath)
      throw new DiscussError('HASH_MISMATCH', 'relayed file does not match the declared sha256', {
        details: { expected, actual: sha256 },
      })
    }
    return { sha256, size: bytes }
  }

  /** @param {string} path */
  #discard(path) {
    try {
      unlinkSync(path)
    } catch {
      // The temporary file is already gone.
    }
  }

  /**
   * Follow the host gateway (one per installation) until `signal` aborts.
   * @param {string} installationId
   * @param {{ signal: AbortSignal, onFrame: (frame: any) => void }} options
   */
  async hostStream(installationId, options) {
    const url = new URL('/v1/host-gateway', this.baseUrl)
    url.searchParams.set('installationId', installationId)
    let response
    try {
      response = await this.fetchImpl(url, {
        signal: options.signal,
        headers: { Accept: 'text/event-stream' },
      })
    } catch (error) {
      if (options.signal.aborted) throw error
      throw new DiscussError('SERVER_UNREACHABLE', `host gateway unreachable: ${String(error)}`, {
        retryable: true,
        cause: error,
      })
    }
    if (!response.ok) {
      throw new DiscussError('SERVER_UNREACHABLE', `host gateway HTTP ${response.status}`, {
        retryable: response.status >= 500,
        status: response.status,
      })
    }
    await readSse(response.body, options.onFrame)
  }

  /**
   * @param {string} probeId
   * @param {string} installationId
   * @param {{ ok: boolean, code?: string }} result
   */
  hostProbe(probeId, installationId, result) {
    return this.request(`/v1/host-probe/${encodeURIComponent(probeId)}`, {
      method: 'POST',
      body: { installationId, ...result },
    })
  }

  /**
   * Stream one local file to the board's relay endpoint.
   * @param {string} transferId
   * @param {string} installationId
   * @param {string} path
   * @param {number} size
   */
  async relayUpload(transferId, installationId, path, size) {
    const url = new URL(`/v1/relay/${encodeURIComponent(transferId)}`, this.baseUrl)
    url.searchParams.set('installationId', installationId)
    let response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
        body: Readable.toWeb(createReadStream(path)),
        duplex: 'half',
        // A stalled board or requester must not hold this host's relay slot.
        signal: AbortSignal.timeout(this.uploadTimeoutMs),
      })
    } catch (error) {
      throw new DiscussError('SERVER_UNREACHABLE', `relay upload failed: ${String(error)}`, {
        retryable: true,
        cause: error,
      })
    }
    if (!response.ok) {
      throw new DiscussError('TRANSFER_FAILED', `relay HTTP ${response.status}`, { status: response.status })
    }
    await response.text()
  }

  /**
   * @param {string} transferId
   * @param {string} installationId
   * @param {string} code
   */
  relayFail(transferId, installationId, code) {
    const url = new URL(`/v1/relay/${encodeURIComponent(transferId)}/fail`, this.baseUrl)
    url.searchParams.set('installationId', installationId)
    return this.request(url.pathname + url.search, { method: 'POST', body: { code } })
  }
}

/**
 * Exponential reconnect delay, capped at 30s.
 * @param {number} attempt
 * @returns {number}
 */
export function reconnectDelay(attempt) {
  return Math.min(30_000, 500 * 2 ** Math.min(attempt, 6))
}
