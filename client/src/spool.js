import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, truncateSync, writeSync, fsyncSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Durable per-session spool. The client acks mail as soon as it is written
 * here, so a crash between ack and inject does not lose it.
 */
export class Spool {
  /** @param {string} path */
  constructor(path) {
    this.path = path
  }

  /**
   * Append messages and fsync before returning.
   * @param {Array<Record<string, unknown>>} messages
   */
  append(messages) {
    if (messages.length === 0) return
    mkdirSync(dirname(this.path), { recursive: true })
    const fd = openSync(this.path, 'a', 0o600)
    try {
      for (const message of messages) writeSync(fd, `${JSON.stringify(message)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  /**
   * Replace the spool with exactly these messages. Used when receipt trimming
   * drops the oldest buffered message so the spool never outgrows the buffer.
   * @param {Array<Record<string, unknown>>} messages
   */
  replace(messages) {
    mkdirSync(dirname(this.path), { recursive: true })
    // Write a sibling temp file and rename: truncating in place would lose the
    // whole spool if the process died mid-write.
    const temporary = `${this.path}.${process.pid}.tmp`
    const fd = openSync(temporary, 'w', 0o600)
    try {
      for (const message of messages) writeSync(fd, `${JSON.stringify(message)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, this.path)
  }

  /** @returns {Array<any>} messages that were acknowledged but not injected */
  load() {
    if (!existsSync(this.path)) return []
    const text = readFileSync(this.path, 'utf8')
    const messages = []
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        messages.push(JSON.parse(line))
      } catch {
        // A torn trailing line from a crash is dropped; the server can resend.
      }
    }
    return messages
  }

  /** Drop everything once the messages are safely inside the agent inbox. */
  clear() {
    if (!existsSync(this.path)) return
    truncateSync(this.path, 0)
  }
}
