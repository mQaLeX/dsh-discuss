import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { newInstallationId } from '../../shared/ids.js'

/**
 * Default path of the per-host identity file. It holds one key only —
 * `installationId` — because every other client setting belongs to the DSH
 * plugin config (per profile).
 * @returns {string}
 */
export function defaultInstallationPath() {
  if (process.env.DISCUSS_INSTALLATION_FILE) return process.env.DISCUSS_INSTALLATION_FILE
  // Kept for environments that set the pre-rename variable.
  if (process.env.DISCUSS_CLIENT_CONFIG) return process.env.DISCUSS_CLIENT_CONFIG
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(base, 'dsh-discuss', 'installationId.json')
}

/**
 * Block briefly with a real sleep (the identity lock is held for milliseconds).
 * @param {number} ms
 */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(shared, 0, 0, ms)
}

/**
 * Run `fn` while holding an exclusive lock file. Two DSH processes starting at
 * once must agree on one installation id, so the read-modify-write is guarded
 * by `O_EXCL` rather than by hope.
 * @template T
 * @param {string} lockPath
 * @param {() => T} fn
 * @returns {T}
 */
function withLock(lockPath, fn) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let fd
    try {
      fd = openSync(lockPath, 'wx')
    } catch (error) {
      if (error?.code === 'EEXIST') {
        sleepSync(10)
        continue
      }
      throw error
    }
    try {
      return fn()
    } finally {
      closeSync(fd)
      try {
        unlinkSync(lockPath)
      } catch {
        // Another process already removed a stale lock.
      }
    }
  }
  throw new Error(`dsh-discuss: could not acquire ${lockPath}`)
}

/**
 * @param {string} path
 * @returns {string | undefined}
 */
function readInstallationId(path) {
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed?.installationId === 'string' && parsed.installationId.length > 0
      ? parsed.installationId
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Load or create the per-host identity file. The id is minted once under an
 * exclusive lock and reused by every profile and session on the host.
 * @param {string} [path]
 * @returns {{ installationId: string, path: string }}
 */
export function ensureInstallationId(path = defaultInstallationPath()) {
  mkdirSync(dirname(path), { recursive: true })

  const current = readInstallationId(path)
  if (current !== undefined) return { installationId: current, path }

  return withLock(`${path}.lock`, () => {
    // Re-read under the lock: another process may have created it already.
    const locked = readInstallationId(path)
    if (locked !== undefined) return { installationId: locked, path }
    const installationId = newInstallationId()
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ installationId }, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
    return { installationId, path }
  })
}
