import { ERROR_CODES } from './constants.js'

/** One structured failure carrying the board's uniform error payload. */
export class DiscussError extends Error {
  /**
   * @param {string} code - one of ERROR_CODES.
   * @param {string} message - human-readable explanation.
   * @param {{ retryable?: boolean, retryAfterSeconds?: number, details?: unknown, status?: number, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DiscussError'
    this.code = code
    this.retryable = options.retryable === true
    this.retryAfterSeconds = options.retryAfterSeconds === undefined
      ? undefined
      : Math.max(1, Math.ceil(options.retryAfterSeconds))
    this.details = options.details
    this.status = options.status ?? statusFor(code)
  }

  /** @returns {{ ok: false, error: { code: string, message: string, retryable: boolean, retryAfterSeconds?: number, details?: unknown } }} */
  toBody() {
    const error = { code: this.code, message: this.message, retryable: this.retryable }
    if (this.retryAfterSeconds !== undefined) error.retryAfterSeconds = this.retryAfterSeconds
    if (this.details !== undefined) error.details = this.details
    return { ok: false, error }
  }
}

/**
 * Map an error code to its default HTTP status.
 * @param {string} code
 * @returns {number}
 */
export function statusFor(code) {
  switch (code) {
    case 'NOT_SUBSCRIBED':
    case 'SUBAGENT_FORBIDDEN':
    case 'SESSION_ARCHIVED':
      return 403
    case 'TOPIC_NOT_FOUND':
    case 'MESSAGE_NOT_FOUND':
    case 'PARENT_NOT_FOUND':
    case 'FILE_NOT_FOUND':
    case 'NO_ATTACHMENT':
    case 'USER_NOT_FOUND':
      return 404
    case 'REQUEST_CONFLICT':
    case 'TOKEN_HELD':
    case 'COMMENT_EXISTS':
    case 'MENTION_NOT_SUBSCRIBED':
    case 'FILE_NOT_HELD':
      return 409
    case 'FILE_TOO_LARGE':
      return 413
    case 'RATE_LIMITED':
      return 429
    case 'SERVER_UNREACHABLE':
    case 'FILE_UNAVAILABLE':
    case 'TRANSFER_FAILED':
      return 503
    case 'HASH_MISMATCH':
      return 502
    case 'STORE_FULL':
      return 507
    case 'INTERNAL':
      return 500
    default:
      return 400
  }
}

/**
 * Normalize any thrown value into a structured error body.
 * @param {unknown} error
 * @returns {{ body: { ok: false, error: { code: string, message: string, retryable: boolean, retryAfterSeconds?: number, details?: unknown } }, status: number }}
 */
export function toErrorBody(error) {
  if (error instanceof DiscussError) return { body: error.toBody(), status: error.status }
  const message = error instanceof Error ? error.message : String(error)
  const wrapped = new DiscussError('INTERNAL', message, { status: 500 })
  return { body: wrapped.toBody(), status: wrapped.status }
}

/** Ensure a code is part of the published vocabulary (guards typos at review time). */
if (new Set(ERROR_CODES).size !== ERROR_CODES.length) throw new Error('duplicate error code')
