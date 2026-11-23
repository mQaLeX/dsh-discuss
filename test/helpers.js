import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../server/db.js'
import { createDiscussServer } from '../server/http.js'
import { createAdminServer } from '../server/admin.js'

/**
 * Start a discuss server and an admin server on the same database file, each
 * with its own connection — the production topology, minus the network hop.
 * @param {Record<string, any>} [overrides]
 * @param {{ dir?: string }} [options] - reuse a directory to model a restart
 */
export async function startStack(overrides = {}, options = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'dsh-discuss-test-'))
  const dbPath = join(dir, 'discuss.db')
  const dbDiscuss = openDatabase(dbPath)
  const dbAdmin = openDatabase(dbPath)
  // Unset limits fall back to the shipped defaults; tests that depend on a
  // specific limit pass it explicitly.
  const config = {
    retryAfterMs: 120,
    heartbeatMs: 60,
    adminTokenTtlMs: 60_000,
    ...overrides,
  }
  const discuss = createDiscussServer({ db: dbDiscuss, dataDir: dir, config })
  await new Promise(resolve => discuss.server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const admin = createAdminServer({ db: dbAdmin, config })
  await new Promise(resolve => admin.server.listen(options.adminPort ?? 0, '127.0.0.1', resolve))

  const base = `http://127.0.0.1:${discuss.server.address().port}`
  const adminBase = `http://127.0.0.1:${admin.server.address().port}`

  return {
    dir,
    base,
    adminBase,
    db: dbDiscuss,
    dbAdmin,
    discuss,
    admin,
    /** @param {{ keepDir?: boolean }} [closeOptions] */
    async close(closeOptions = {}) {
      await discuss.close().catch(() => {})
      await admin.close().catch(() => {})
      try {
        dbDiscuss.close()
      } catch {}
      try {
        dbAdmin.close()
      } catch {}
      if (closeOptions.keepDir !== true) rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * @param {string} url
 * @param {unknown} body
 * @param {string} [method]
 */
export async function request(url, body, method = 'POST') {
  const init = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (method !== 'GET' && method !== 'HEAD' && body !== undefined) init.body = JSON.stringify(body)
  const response = await fetch(url, init)
  const text = await response.text()
  let parsed
  try {
    parsed = text.length === 0 ? undefined : JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}

/**
 * @param {string} base
 * @param {string} installationId
 * @param {string} sessionId
 */
export function register(base, installationId, sessionId) {
  return request(`${base}/v1/register`, { installationId, sessionId })
}

/**
 * @param {string} adminBase
 * @param {string[]} names
 */
export async function createTopics(adminBase, names) {
  const requestToken = await request(`${adminBase}/v1/admin/topics/request`, {})
  if (requestToken.status !== 200) throw new Error(`request failed: ${JSON.stringify(requestToken.body)}`)
  const confirmed = await request(`${adminBase}/v1/admin/topics/confirm`, {
    token: requestToken.body.token,
    names,
  })
  if (confirmed.status !== 200) throw new Error(`confirm failed: ${JSON.stringify(confirmed.body)}`)
  return confirmed.body.results
}

/**
 * @param {string} base
 * @param {{ installationId: string, sessionId: string }} ids
 * @param {string} topicId
 * @param {boolean} [subscribed]
 */
export function subscribe(base, ids, topicId, subscribed = true) {
  return request(`${base}/v1/subscriptions`, { ...ids, topicId, subscribed }, 'PUT')
}

/**
 * @param {string} base
 * @param {{ installationId: string, sessionId: string }} ids
 * @param {string} topicId
 * @param {string} text
 * @param {{ parentId?: number, requestId?: string }} [extra]
 */
export function post(base, ids, topicId, text, extra = {}) {
  return request(`${base}/v1/messages`, {
    ...ids,
    topicId,
    kind: extra.parentId === undefined ? 'post' : 'comment',
    parentId: extra.parentId,
    requestId: extra.requestId ?? crypto.randomUUID(),
    text,
  })
}

/**
 * Minimal SSE consumer for delivery tests.
 * @param {string} url
 */
export function openStream(url) {
  const controller = new AbortController()
  /** @type {any[]} */
  const events = []
  /** @type {Array<() => void>} */
  const waiters = []
  let closed = false
  const ready = (async () => {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`stream HTTP ${response.status}`)
    let buffer = ''
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString('utf8')
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const data = frame
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim())
          .join('\n')
        if (data.length === 0) continue
        events.push(JSON.parse(data))
        for (const waiter of waiters.splice(0)) waiter()
      }
    }
  })().catch((error) => {
    if (!closed && error?.name !== 'AbortError') throw error
  })

  return {
    events,
    ready,
    /**
     * Wait until `predicate` matches a collected event.
     * @param {(event: any) => boolean} predicate
     * @param {number} [timeoutMs]
     */
    async next(predicate, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = events.find(predicate)
        if (found !== undefined) return found
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('stream wait timeout')), 20)
          waiters.push(() => {
            clearTimeout(timer)
            resolve(undefined)
          })
        }).catch(() => {})
      }
      throw new Error(`stream wait timeout; saw ${JSON.stringify(events)}`)
    },
    close() {
      closed = true
      controller.abort()
    },
  }
}

/**
 * A minimal host that answers `fetch` frames from the board's relay.
 * @param {{ base: string, installationId: string, files: Map<string, Uint8Array> }} options
 */
export function fakeHolder(options) {
  const controller = new AbortController()
  const frames = []
  const ready = Promise.withResolvers()

  async function serve(frame) {
    if (options.delayMs !== undefined) await new Promise(resolve => setTimeout(resolve, options.delayMs))
    const bytes = options.files.get(`${frame.topicId}/${frame.messageId}`)
    const endpoint = `${options.base}/v1/relay/${frame.transferId}`
    const query = `?installationId=${encodeURIComponent(options.installationId)}`
    if (bytes === undefined) {
      await fetch(`${endpoint}/fail${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'FILE_NOT_FOUND' }),
      })
      return
    }
    await fetch(`${endpoint}${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    })
  }

  async function serveProbe(frame) {
    if (typeof frame.probeId !== 'string') return
    let bytes
    for (const value of options.files.values()) {
      if (createHash('sha256').update(value).digest('hex') === frame.sha256) {
        bytes = value
        break
      }
    }
    const sizeMatches = typeof frame.size !== 'number' || frame.size <= 0 || bytes?.length === frame.size
    const ok = bytes !== undefined && sizeMatches
    await fetch(`${options.base}/v1/host-probe/${encodeURIComponent(frame.probeId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installationId: options.installationId,
        ok,
        code: ok ? undefined : (bytes === undefined ? 'FILE_NOT_FOUND' : 'HASH_MISMATCH'),
      }),
    })
  }

  const done = (async () => {
    const response = await fetch(
      `${options.base}/v1/host-gateway?installationId=${encodeURIComponent(options.installationId)}`,
      { signal: controller.signal },
    )
    if (!response.ok) throw new Error(`host gateway HTTP ${response.status}`)
    ready.resolve()
    let buffer = ''
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString('utf8')
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
        const frame = JSON.parse(data)
        frames.push(frame)
        if (frame.type === 'fetch') await serve(frame)
        else if (frame.type === 'probe') await serveProbe(frame)
      }
    }
  })().catch((error) => {
    if (!controller.signal.aborted) frames.push({ error: String(error) })
  })

  return {
    ready: ready.promise,
    frames,
    done,
    close() {
      controller.abort()
    },
  }
}
