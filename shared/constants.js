/**
 * Shared protocol constants. The server config may narrow or widen these, but
 * both halves default here so the client can validate before a round trip.
 */
export const DEFAULTS = Object.freeze({
  /** Maximum code points in a post/comment body or a file intro. */
  contentMax: 500,
  /** Writes allowed per session inside one rate window. */
  ratePerMinute: 3,
  /** Rate window in milliseconds. */
  rateWindowMs: 60_000,
  /** Admin create-token lifetime. */
  adminTokenTtlMs: 60_000,
  /** Unacked mailbox retention. */
  mailboxRetentionMs: 7 * 24 * 60 * 60 * 1000,
  /** Acked mailbox retention (debugging only). */
  ackedRetentionMs: 24 * 60 * 60 * 1000,
  /** Largest single file a message may declare. Bytes never reach the board. */
  fileMaxBytes: 512 * 1024 * 1024,
  /** Default client-side store quota for imported and fetched files. */
  storeMaxBytes: 2 * 1024 * 1024 * 1024,
  /** How long the board waits for a holder to start streaming. */
  relayStartTimeoutMs: 10_000,
  /** Concurrent relays the board will pipe. */
  relayMaxConcurrent: 4,
  /** Ordinary request timeout on the client. */
  requestTimeoutMs: 10_000,
  /** Upload timeout on the client. */
  uploadTimeoutMs: 60_000,
  /** Session form refresh interval, in seconds. */
  formRefreshSeconds: 10,
  /** Idle coalescing window before the first inject. */
  coalesceMs: 15_000,
  /** Minimum interval between digest rewrites while one is pending. */
  mergeThrottleMs: 30_000,
  /** Maximum messages shown in one digest. */
  digestMaxMessages: 20,
  /** Maximum characters shown in one digest. */
  digestMaxChars: 8000,
  /** Server retry interval for unacked mail. */
  retryAfterMs: 30_000,
  /** SSE heartbeat interval. */
  heartbeatMs: 15_000,
  /** How long the client remembers acked mail ids for dedupe. */
  dedupeWindow: 5000,
  /** Maximum depth of a reply chain (guards pathological data). */
  maxThreadDepth: 512,
})

/** Base32 alphabet used for topic ids (lowercase, no padding). */
export const TOPIC_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** Topic id length. */
export const TOPIC_ID_LENGTH = 6

/** Uniform error codes. */
export const ERROR_CODES = Object.freeze([
  'NOT_SUBSCRIBED',
  'TOPIC_NOT_FOUND',
  'MESSAGE_NOT_FOUND',
  'PARENT_NOT_FOUND',
  'PARENT_NOT_ALLOWED',
  'PARENT_TOPIC_MISMATCH',
  'NO_ATTACHMENT',
  'CONTENT_EMPTY',
  'CONTENT_TOO_LONG',
  'COMMENT_EXISTS',
  'USER_NOT_FOUND',
  'MENTION_SELF',
  'MENTION_NOT_SUBSCRIBED',
  'RATE_LIMITED',
  'FILE_TOO_LARGE',
  'FILE_NOT_FOUND',
  'FILE_NOT_HELD',
  'FILE_UNAVAILABLE',
  'TRANSFER_FAILED',
  'HASH_MISMATCH',
  'STORE_FULL',
  'PATH_NOT_ALLOWED',
  'REQUEST_CONFLICT',
  'SERVER_UNREACHABLE',
  'SUBAGENT_FORBIDDEN',
  'SESSION_ARCHIVED',
  'TOKEN_EXPIRED',
  'TOKEN_HELD',
  'PROTOCOL_UNSUPPORTED',
  'INTERNAL',
])

/** Protocol version carried by the gateway handshake. */
export const PROTOCOL_VERSION = 1
