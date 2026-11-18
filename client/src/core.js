import { DEFAULTS } from '../../shared/constants.js'
import { DiscussError } from '../../shared/errors.js'
import { renderDigest } from './digest.js'
import { reconnectDelay } from './api.js'

const ACK_BATCH_MS = 200
const RUNNING_POLL_MS = 1000
const MAIL_MEMORY = 5_000
/**
 * A reply or mention that reaches a running turn is injected at the next step
 * boundary. That is the expensive direction: every injection grows the context
 * of the turn already in flight, so it is budgeted. A follow-up turn is not
 * budgeted: an agent that keeps getting woken can stop it by unsubscribing.
 */
const RUNNING_INJECT_COOLDOWN_MS = 60_000
const RUNNING_INJECT_BUDGET_PER_HOUR = 6

/**
 * One agent session's view of the board: registration, SSE delivery, the
 * durable spool, the injected digest, and the injection policy.
 *
 * Policy: a reply to this session or a mention of it is the only activity that
 * may start a turn. When the session is idle such a batch is delivered as a
 * follow-up turn, un-budgeted: a session that does not want those turns can
 * unsubscribe from the topic. While the agent runs the batch is injected at the
 * next step boundary instead, and that direction is budgeted — every injection
 * grows the context of the turn already in flight. Everything else is context
 * only: while idle the first batch coalesces for `coalesceMs`, later arrivals
 * merge into the pending digest at most every `mergeThrottleMs` (or immediately
 * at the message cap), and a `running -> idle` transition flushes at once.
 *
 * A digest injected into a running turn can be left parked when that turn ends
 * before a step claims it; the idle transition probes the inbox and re-delivers
 * it as the follow-up turn it was meant to be.
 */
export class SessionClient {
  /**
   * @param {{
   *   ids: { installationId: string, sessionId: string },
   *   agent: { status: 'idle' | 'running', inject: (message: any) => void, inbox: { remove: (id: string) => boolean } },
   *   api: any,
   *   spool: { append: (messages: any[]) => void, load: () => any[], clear: () => void },
   *   makeMessage: (text: string, count: number) => any,
   *   config?: Record<string, any>,
   *   now?: () => number,
   *   requestId?: () => string,
   *   logger?: { warn: (message: string) => void },
   *   onStateChange?: () => void,
   * }} options
   */
  constructor(options) {
    this.ids = options.ids
    this.agent = options.agent
    this.api = options.api
    this.spool = options.spool
    this.makeMessage = options.makeMessage
    this.now = options.now ?? (() => Date.now())
    this.requestId = options.requestId ?? (() => crypto.randomUUID())
    this.logger = options.logger ?? console
    this.onStateChange = options.onStateChange
    this.config = {
      coalesceMs: options.config?.coalesceMs ?? DEFAULTS.coalesceMs,
      mergeThrottleMs: options.config?.mergeThrottleMs ?? DEFAULTS.mergeThrottleMs,
      digestMaxMessages: options.config?.digestMaxMessages ?? DEFAULTS.digestMaxMessages,
      digestMaxChars: options.config?.digestMaxChars ?? DEFAULTS.digestMaxChars,
      bufferMaxMessages: options.config?.bufferMaxMessages
        ?? options.config?.digestMaxMessages
        ?? DEFAULTS.digestMaxMessages,
    }

    this.username = undefined
    this.limits = {
      contentMax: DEFAULTS.contentMax,
      ratePerMinute: DEFAULTS.ratePerMinute,
      fileMaxBytes: DEFAULTS.fileMaxBytes,
    }
    /** @type {any[]} */
    this.pending = []
    /** Messages dropped from `pending` since the last render. */
    this.pendingDropped = 0
    /** Per-topic id ranges for the dropped messages (for the omission line). */
    this.pendingDroppedRanges = []
    /** @type {{ messageId: string, text: string, messages: any[], omitted?: number, omittedRanges?: Array<{ topicId: string, from: number, to: number }>, wakeEligible?: boolean, woke?: boolean } | null} */
    this.digest = null
    this.firstPendingAt = null
    this.lastRewriteAt = 0
    /**
     * Digests this client removed from the inbox itself. `inbox.remove` emits
     * `agent/inbox/discarded` synchronously, and that event means "the host
     * dropped an unclaimed digest", not "put it back in the queue".
     */
    this.discarding = new Set()
    /** Timestamps of injections into a running turn inside the rolling hour. */
    this.runningInjectTimes = []
    /** When the last running injection was delivered. */
    this.lastRunningInjectAt = -Infinity
    /** @type {Set<number>} */
    this.seenMail = new Set()
    /** @type {number[]} */
    this.seenOrder = []
    /** @type {number[]} */
    this.ackQueue = []
    this.ackTimer = undefined
    this.timer = undefined
    this.registration = undefined
    /** Cached subscription state; unknown until the first topics() call. */
    this.subscriptionsKnown = false
    this.subscribedCount = 0
    this.primed = false
    this.closed = false
    this.connected = false
    this.abort = new AbortController()
    /** Aborted on archive pause; replaced on resume so a new loop can run. */
    this.connectionAbort = new AbortController()
    /** Monotonic token that retires an older connect loop. */
    this.connectionGeneration = 0
    this.paused = false
    this.active = false
    this.started = false
  }

  /** Restore the spool, register, and follow the gateway. Never rejects. */
  start() {
    if (this.started) return
    this.started = true
    try {
      const restored = this.spool.load()
      if (restored.length > 0) {
        // Seed the dedupe set too: an ack lost before the crash makes the
        // server resend these very messages on reconnect.
        for (const message of restored) {
          if (typeof message?.mailId === 'number') this.#rememberMail(message.mailId)
        }
        this.pending.push(...restored)
        this.firstPendingAt = this.now()
        this.#trimPending()
      }
    } catch (error) {
      this.logger.warn(`dsh-discuss: spool restore failed: ${String(error)}`)
    }
    if (this.paused) {
      this.#notify()
      return
    }
    void this.#connectLoop()
    this.#schedule()
    this.#notify()
  }

  /** Register once; concurrent callers share the attempt. */
  async ensureRegistered() {
    if (this.paused) {
      throw new DiscussError('SESSION_ARCHIVED', 'this session is archived; the discussion board is paused for it')
    }
    if (this.active) return { username: this.username, limits: this.limits }
    if (this.registration === undefined) {
      this.registration = this.api.register(this.ids)
        .then((result) => {
          this.username = result.username
          this.active = true
          if (result.limits !== undefined) this.limits = { ...this.limits, ...result.limits }
          this.registration = undefined
          void this.#primeSubscriptions()
          this.#notify()
          return { username: this.username, limits: this.limits }
        })
        .catch((error) => {
          this.registration = undefined
          throw error
        })
    }
    return this.registration
  }

  async #connectLoop() {
    const generation = ++this.connectionGeneration
    const signal = AbortSignal.any([this.abort.signal, this.connectionAbort.signal])
    const retired = () => this.closed || this.paused || generation !== this.connectionGeneration
    let attempt = 0
    while (!retired()) {
      try {
        await this.ensureRegistered()
        this.connected = true
        await this.api.stream(this.ids, {
          signal,
          onFrame: (frame) => this.#onFrame(frame),
        })
        attempt = 0
      } catch (error) {
        if (retired()) return
        this.logger.warn(`dsh-discuss: gateway error: ${String(error)}`)
      }
      this.connected = false
      if (retired()) return
      // The board may have lost our row (database restore or a redeploy on a
      // fresh store). A cached username would then name a session the server
      // no longer has, while writes silently mint a new one. Drop the cache so
      // the next attempt registers again and adopts whatever name the server
      // now answers with.
      this.active = false
      await this.#delay(reconnectDelay(attempt))
      attempt += 1
    }
  }

  /** @param {any} frame */
  #onFrame(frame) {
    if (frame?.type === 'welcome') {
      this.connected = true
      return
    }
    if (frame?.type !== 'delivery') return
    const messages = Array.isArray(frame.messages) ? frame.messages : []
    this.deliver(messages)
  }

  /**
   * Handle already-fetched messages (frames, spool replay, tests).
   * @param {any[]} messages
   */
  deliver(messages) {
    for (const message of messages) this.#receive(message)
  }

  /** Handle one delivered message: dedupe, spool, ack, buffer. */
  #receive(message) {
    if (this.closed) return
    if (typeof message?.mailId !== 'number') return
    if (this.seenMail.has(message.mailId)) return
    this.#rememberMail(message.mailId)
    this.pending.push(message)
    if (this.firstPendingAt === null) this.firstPendingAt = this.now()
    const before = this.pending.length
    this.#trimPending()
    if (this.pending.length === before) {
      try {
        this.spool.append([message])
      } catch (error) {
        this.logger.warn(`dsh-discuss: spool append failed: ${String(error)}`)
      }
    }
    this.#queueAck(message.mailId)
    this.#notify()
    this.#schedule()
  }

  /**
   * Drop the oldest buffered messages so memory stays bounded at the digest
   * size even while the agent is running. The dropped ones were never rendered
   * and are only reachable through `discuss_history`.
   */
  #trimPending() {
    const overflow = this.pending.length - this.config.bufferMaxMessages
    if (overflow <= 0) return
    const dropped = this.pending.splice(0, overflow)
    this.pendingDropped += dropped.length
    this.#rememberDropped(dropped)
    this.#rewriteSpool()
  }

  /** @param {any[]} messages */
  #rememberDropped(messages) {
    for (const message of messages) {
      const topicId = message?.topicId
      const messageId = message?.messageId
      if (typeof topicId !== 'string' || !Number.isSafeInteger(messageId)) continue
      this.#addDroppedRange(topicId, messageId)
    }
  }

  /** @param {string} topicId @param {number} messageId */
  #addDroppedRange(topicId, messageId) {
    const ranges = this.pendingDroppedRanges
    for (let index = ranges.length - 1; index >= 0; index -= 1) {
      const range = ranges[index]
      if (range.topicId !== topicId) continue
      if (messageId === range.to + 1) {
        range.to = messageId
        return
      }
      if (messageId === range.from - 1) {
        range.from = messageId
        return
      }
      if (messageId >= range.from && messageId <= range.to) return
    }
    // Delivery order makes gaps rare; a bounded list keeps memory flat if one
    // ever appears. The omitted count stays exact even when this cap is hit.
    if (ranges.length < 64) ranges.push({ topicId, from: messageId, to: messageId })
  }

  /** Keep the spool in sync with `pending` after a trim. */
  #rewriteSpool() {
    try {
      this.spool.replace(this.pending)
    } catch (error) {
      this.logger.warn(`dsh-discuss: spool rewrite failed: ${String(error)}`)
    }
  }

  /** @param {number} mailId */
  #rememberMail(mailId) {
    this.seenMail.add(mailId)
    this.seenOrder.push(mailId)
    if (this.seenOrder.length > MAIL_MEMORY) {
      const dropped = this.seenOrder.shift()
      if (dropped !== undefined) this.seenMail.delete(dropped)
    }
  }

  /** @param {number} mailId */
  #queueAck(mailId) {
    this.ackQueue.push(mailId)
    if (this.ackTimer !== undefined) return
    this.ackTimer = setTimeout(() => {
      this.ackTimer = undefined
      void this.#flushAck()
    }, ACK_BATCH_MS)
    this.ackTimer.unref?.()
  }

  async #flushAck() {
    if (this.closed || this.ackQueue.length === 0) return
    const batch = this.ackQueue.splice(0, this.ackQueue.length)
    try {
      await this.api.ack(this.ids, batch)
    } catch (error) {
      if (this.closed) return
      this.logger.warn(`dsh-discuss: ack failed: ${String(error)}`)
      this.ackQueue.unshift(...batch)
      setTimeout(() => void this.#flushAck(), 1000).unref?.()
    }
  }

  /** @returns {number | undefined} */
  #nextDelay() {
    if (this.pending.length === 0 && this.digest === null) return undefined
    if (this.agent.status === 'running') return RUNNING_POLL_MS
    // A reply or mention is delivered on the next tick, never after a window
    // the agent is not working in.
    if (this.#wantsWake(this.pending)) return 0
    if (this.digest !== null) {
      if (this.pending.length === 0) return undefined
      if (this.digest.messages.length + this.pending.length >= this.config.digestMaxMessages) return 0
      return Math.max(0, this.lastRewriteAt + this.config.mergeThrottleMs - this.now())
    }
    return Math.max(0, (this.firstPendingAt ?? this.now()) + this.config.coalesceMs - this.now())
  }

  /** @param {number} [delay] */
  #schedule(delay) {
    if (this.closed || this.paused) return
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const next = delay ?? this.#nextDelay()
    if (next === undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.tick()
    }, Math.max(0, next))
    this.timer.unref?.()
  }

  /**
   * Advance the injection policy. Called by the timer, by status transitions,
   * and by tests.
   * @param {boolean} [force] - flush now, ignoring the coalescing window.
   */
  tick(force = false) {
    if (this.closed || this.paused) return
    if (this.pending.length === 0) {
      this.#schedule()
      return
    }
    if (this.agent.status === 'running') {
      // A reply or mention is handed to this turn's next step boundary; it never
      // wakes a driver that is already awake. A digest already in the inbox is
      // merged once the turn ends, so nothing is injected twice.
      if (this.digest === null && this.#wantsWake(this.pending) && this.#runningInjectAllowed()) {
        // The budget is spent only once the injection actually landed.
        if (this.#inject(false)) this.#recordRunningInject()
        return
      }
      this.#schedule(RUNNING_POLL_MS)
      return
    }
    if (this.digest !== null) {
      const total = this.digest.messages.length + this.pending.length
      // A reply or mention bypasses the merge throttle: it is the one arrival
      // that should not wait out a window the agent is not working in.
      const due = force || total >= this.config.digestMaxMessages
        || this.#wantsWake(this.pending)
        || this.now() - this.lastRewriteAt >= this.config.mergeThrottleMs
      if (due) this.#merge(true)
      else this.#schedule()
      return
    }
    // A reply or mention waiting on an idle session starts its turn now,
    // without the coalescing window: the point of waking is to answer promptly.
    if (this.#wantsWake(this.pending)) {
      this.#inject(true)
      return
    }
    const age = this.now() - (this.firstPendingAt ?? this.now())
    if (force || age >= this.config.coalesceMs) this.#inject()
    else this.#schedule()
  }

  /** @param {number} total @param {Array<{ topicId: string, from: number, to: number }>} [omittedRanges] */
  #renderOptions(total, omittedRanges = this.pendingDroppedRanges) {
    return {
      maxMessages: this.config.digestMaxMessages,
      maxChars: this.config.digestMaxChars,
      total,
      omittedRanges,
    }
  }

  /**
   * Whether a batch contains something addressed to this session: a reply to
   * one of its messages, or a mention. Only these may start a turn.
   * @param {any[]} messages
   */
  #wantsWake(messages) {
    if (this.paused) return false
    for (const message of messages) {
      if (message?.toYou === true || message?.mentionYou === true) return true
    }
    return false
  }

  /** Whether one more injection into a running turn fits the budget. */
  #runningInjectAllowed() {
    const now = this.now()
    const windowStart = now - 60 * 60 * 1000
    this.runningInjectTimes = this.runningInjectTimes.filter(at => at > windowStart)
    if (this.runningInjectTimes.length >= RUNNING_INJECT_BUDGET_PER_HOUR) return false
    return now - this.lastRunningInjectAt >= RUNNING_INJECT_COOLDOWN_MS
  }

  #recordRunningInject() {
    this.lastRunningInjectAt = this.now()
    this.runningInjectTimes.push(this.lastRunningInjectAt)
  }

  /**
   * Deliver one digest: a follow-up turn when asked, plain context otherwise.
   * A host without `followup` falls back to context, which only means the
   * reader sees the batch at its next turn.
   * @param {any} message
   * @param {boolean} wake
   * @returns {boolean} whether the driver was woken
   */
  #send(message, wake) {
    if (wake === true && typeof this.agent.followup === 'function') {
      this.agent.followup(message)
      return true
    }
    this.agent.inject(message)
    return false
  }

  /**
   * @param {boolean} [wake] - deliver as a follow-up turn (may start a turn)
   */
  /**
   * Publish the digest entry for a message that is about to be sent. A host
   * claims a follow-up synchronously inside `followup()`, so `onClaimed` can
   * arrive before `#send` returns and must find the entry to clear it.
   * @returns {{ messageId: string, text: string, messages: any[], omitted: number, omittedRanges: any[], wakeEligible: boolean, woke: boolean }}
   */
  #beginDigest(message, rendered, total, wakeEligible) {
    this.digest = {
      messageId: message.id,
      text: rendered.text,
      messages: rendered.retained,
      omitted: total - rendered.retained.length,
      omittedRanges: rendered.omittedRanges,
      wakeEligible,
      woke: false,
    }
    return this.digest
  }

  /**
   * Record whether the send actually woke the driver, unless the host already
   * claimed (and cleared) the entry.
   * @param {string} messageId
   * @param {boolean} woke
   */
  #finishDigest(messageId, woke) {
    if (this.digest !== null && this.digest.messageId === messageId) this.digest.woke = woke === true
  }

  /** @param {boolean} [wake] @returns {boolean} whether the digest was sent */
  #inject(wake = false) {
    const messages = this.pending.slice()
    const total = this.pendingDropped + messages.length
    const rendered = renderDigest(messages, this.#renderOptions(total))
    const message = this.makeMessage(rendered.text, messages.length)
    const wakeEligible = this.#wantsWake(messages)
    this.#beginDigest(message, rendered, total, wakeEligible)
    let woke
    try {
      woke = this.#send(message, wake === true && wakeEligible)
    } catch (error) {
      this.digest = null
      this.logger.warn(`dsh-discuss: inject failed: ${String(error)}`)
      this.#schedule(RUNNING_POLL_MS)
      return false
    }
    // Keep only what the digest actually rendered; everything older is dropped
    // from memory (the digest text points the model at history).
    this.#finishDigest(message.id, woke)
    this.pending = []
    this.pendingDropped = 0
    this.pendingDroppedRanges = []
    this.firstPendingAt = null
    this.lastRewriteAt = this.now()
    this.#clearSpool()
    this.#notify()
    this.#schedule()
    return true
  }

  /** @param {boolean} [wake] - deliver the merged digest as a follow-up turn */
  #merge(wake = false) {
    const previous = this.digest
    if (previous === null) {
      this.#inject()
      return
    }
    let messages = [...previous.messages, ...this.pending]
    let total = (previous.omitted ?? 0) + messages.length + this.pendingDropped
    let omittedRanges = [...(previous.omittedRanges ?? []), ...this.pendingDroppedRanges]
    let removed = false
    try {
      // The removal emits `agent/inbox/discarded` synchronously; the discarding
      // set tells onDiscarded that this is a rewrite, not a lost digest.
      this.discarding.add(previous.messageId)
      removed = this.agent.inbox.remove(previous.messageId)
    } catch (error) {
      this.logger.warn(`dsh-discuss: inbox remove failed: ${String(error)}`)
    } finally {
      this.discarding.delete(previous.messageId)
    }
    if (!removed) {
      // The digest was claimed between our check and this rewrite; only the
      // unclaimed arrivals belong in the next digest.
      messages = this.pending.slice()
      total = messages.length + this.pendingDropped
      omittedRanges = this.pendingDroppedRanges.slice()
      this.digest = null
      if (messages.length === 0) {
        this.pendingDropped = 0
        this.pendingDroppedRanges = []
        this.#schedule()
        return
      }
    }
    const rendered = renderDigest(messages, this.#renderOptions(total, omittedRanges))
    const message = this.makeMessage(rendered.text, messages.length)
    const wakeEligible = this.#wantsWake(messages)
    this.#beginDigest(message, rendered, total, wakeEligible)
    let woke
    try {
      woke = this.#send(message, wake === true && wakeEligible && previous?.woke !== true)
    } catch (error) {
      this.digest = null
      this.logger.warn(`dsh-discuss: merge inject failed: ${String(error)}`)
      this.pending = messages
      this.#schedule(RUNNING_POLL_MS)
      return
    }
    this.#finishDigest(message.id, woke)
    this.pending = []
    this.pendingDropped = 0
    this.pendingDroppedRanges = []
    this.firstPendingAt = null
    this.lastRewriteAt = this.now()
    this.#clearSpool()
    this.#notify()
    this.#schedule()
  }

  #clearSpool() {
    try {
      this.spool.clear()
    } catch (error) {
      this.logger.warn(`dsh-discuss: spool clear failed: ${String(error)}`)
    }
  }

  /**
   * Pull every un-injected message into one digest for the caller. The digest
   * is returned as the tool result, not injected: nothing enters the inbox and
   * the messages cannot be delivered twice. An already-injected digest is left
   * untouched.
   * @returns {{ text: string, count: number, shown: number, omitted: number } | null}
   */
  refresh() {
    if (this.closed || this.pending.length === 0) return null
    const messages = this.pending.slice()
    const total = this.pendingDropped + messages.length
    const rendered = renderDigest(messages, this.#renderOptions(total))
    this.pending = []
    this.pendingDropped = 0
    this.pendingDroppedRanges = []
    this.firstPendingAt = null
    this.#clearSpool()
    this.#notify()
    this.#schedule()
    return { text: rendered.text, count: messages.length, shown: rendered.shown, omitted: rendered.omitted }
  }

  /**
   * Pause delivery for an archived session: close the stream, stop the timers
   * and release the registration. The client, its tools, the pending buffer and
   * the spool stay alive so an unarchive can resume without losing anything.
   * @returns {Promise<void>}
   */
  async pause() {
    if (this.closed || this.paused) return
    this.paused = true
    this.active = false
    this.connectionGeneration += 1
    this.connectionAbort.abort()
    this.connected = false
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.ackTimer !== undefined) {
      clearTimeout(this.ackTimer)
      this.ackTimer = undefined
    }
    await this.#flushAck()
    try {
      await this.api.unregister(this.ids)
    } catch (error) {
      this.logger.warn(`dsh-discuss: unregister on archive failed: ${String(error)}`)
    }
    this.#notify()
  }

  /** Resume delivery after an unarchive: register again and reconnect. */
  resume() {
    if (this.closed || !this.paused) return
    this.paused = false
    this.connectionAbort = new AbortController()
    void this.#connectLoop()
    this.#schedule()
    this.#notify()
  }

  /**
   * The inbox dropped our digest before the model claimed it (cancellation or
   * archive). Put those messages back so the next turn can inject them again.
   * @param {string} messageId
   */
  onDiscarded(messageId) {
    // A removal this client asked for is a rewrite, not a loss.
    if (this.discarding.has(messageId)) return
    if (this.digest === null || this.digest.messageId !== messageId) return
    const messages = this.digest.messages
    this.pendingDropped += this.digest.omitted ?? 0
    this.pendingDroppedRanges = [...(this.digest.omittedRanges ?? []), ...this.pendingDroppedRanges]
    this.digest = null
    if (messages.length > 0) {
      this.pending = [...messages, ...this.pending]
      if (this.firstPendingAt === null) this.firstPendingAt = this.now()
      this.#trimPending()
      this.#rewriteSpool()
    }
    this.#notify()
    this.#schedule()
  }

  /**
   * The injected digest was claimed by the model; its backlog is gone.
   * @param {string} messageId
   */
  onClaimed(messageId) {
    if (this.digest !== null && this.digest.messageId === messageId) {
      this.digest = null
      this.#notify()
      this.#schedule()
    }
  }

  /**
   * @param {'idle' | 'running'} status
   */
  onStatus(status) {
    if (status !== 'idle') return
    this.#wakeParked()
    this.tick(true)
  }

  /**
   * A digest injected into a running turn can be left parked when that turn
   * ends before a step claims it. An idle driver only wakes for a follow-up, so
   * probe the inbox and re-deliver it as the turn it was meant to start. A new
   * batch in `pending` is left to the merge path, which decides the same thing
   * once it has combined both.
   */
  #wakeParked() {
    const digest = this.digest
    if (digest === null || digest.wakeEligible !== true || digest.woke === true) return
    if (this.closed || this.paused || this.pending.length > 0) return
    if (typeof digest.text !== 'string') return
    if (typeof this.agent.followup !== 'function') return
    let parked = false
    try {
      this.discarding.add(digest.messageId)
      parked = this.agent.inbox.remove(digest.messageId)
    } catch (error) {
      this.logger.warn(`dsh-discuss: inbox probe failed: ${String(error)}`)
      return
    } finally {
      this.discarding.delete(digest.messageId)
    }
    if (!parked) return
    const message = this.makeMessage(digest.text, digest.messages.length)
    // Publish the new identity before sending: the follow-up claims it inside
    // the call, and that claim must clear this entry rather than a stale one.
    this.digest = { ...digest, messageId: message.id, woke: false }
    try {
      this.agent.followup(message)
    } catch (error) {
      this.digest = null
      this.logger.warn(`dsh-discuss: wake failed: ${String(error)}`)
      return
    }
    this.#finishDigest(message.id, true)
  }

  /** Per-topic unprocessed counts for the session form. */
  backlog() {
    /** @type {Record<string, { injected: number, pending: number }>} */
    const counts = {}
    const bump = (topicId, field) => {
      if (typeof topicId !== 'string') return
      const entry = counts[topicId] ?? { injected: 0, pending: 0 }
      entry[field] += 1
      counts[topicId] = entry
    }
    for (const message of this.digest?.messages ?? []) bump(message.topicId, 'injected')
    for (const message of this.pending) bump(message.topicId, 'pending')
    return counts
  }

  #notify() {
    try {
      this.onStateChange?.()
    } catch {
      // A UI callback must never break delivery.
    }
  }

  /** @param {number} ms */
  #delay(ms) {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve()
        return
      }
      const signal = AbortSignal.any([this.abort.signal, this.connectionAbort.signal])
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      timer.unref?.()
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  async topics() {
    await this.ensureRegistered()
    const result = await this.api.topics(this.ids)
    this.#rememberSubscriptions(result)
    return result
  }

  /**
   * Prime the subscription cache right after registration so the prompt
   * section can stay empty for sessions that have no topics yet.
   */
  async #primeSubscriptions() {
    if (this.primed) return
    this.primed = true
    try {
      this.#rememberSubscriptions(await this.api.topics(this.ids))
    } catch {
      this.primed = false
    }
  }

  /** @param {{ subscribed?: unknown[] }} result */
  #rememberSubscriptions(result) {
    this.subscribedCount = Array.isArray(result?.subscribed) ? result.subscribed.length : 0
    this.subscriptionsKnown = true
    this.primed = true
    this.#notify()
  }

  /** @param {string} topicId */
  async unsubscribe(topicId) {
    await this.ensureRegistered()
    await this.api.setSubscription(this.ids, topicId, false)
    this.pending = this.pending.filter(message => message.topicId !== topicId)
    // The spool must agree with the buffer, or a restart replays the dropped
    // topic into the next digest.
    this.#rewriteSpool()
    this.#notify()
    // Refresh the cache so losing the last topic drops the prompt section now.
    this.topics().catch(() => {})
  }

  /**
   * Toggle one subscription from the session panel. Unsubscribing goes through
   * {@link unsubscribe} so the buffered messages and the spool are dropped the
   * same way the tool does it.
   * @param {string} topicId
   * @param {boolean} subscribed
   */
  async setSubscription(topicId, subscribed) {
    if (subscribed) {
      await this.ensureRegistered()
      await this.api.setSubscription(this.ids, topicId, true)
      this.topics().catch(() => {})
      return
    }
    await this.unsubscribe(topicId)
  }

  /**
   * @param {string} topicId
   * @param {string} text
   */
  /**
   * @param {string} topicId
   * @param {string} text
   * @param {string} [at]
   */
  async post(topicId, text, at) {
    await this.ensureRegistered()
    const result = await this.api.write(this.ids, {
      topicId, kind: 'post', requestId: this.requestId(), text, at,
    })
    return result.id
  }

  /**
   * @param {string} topicId
   * @param {string} text
   * @param {number} parentId
   * @param {string} [at]
   */
  async comment(topicId, text, parentId, at) {
    await this.ensureRegistered()
    const result = await this.api.write(this.ids, {
      topicId, kind: 'comment', parentId, requestId: this.requestId(), text, at,
    })
    return result.id
  }

  /**
   * Declare a locally held file in a topic.
   * @param {string} topicId
   * @param {string} intro
   * @param {string} sha256
   * @param {number} size
   * @param {number} [parentId]
   * @param {string} [at]
   * @returns {Promise<{ id: number, duplicate: boolean }>}
   */
  async shareFile(topicId, intro, sha256, size, parentId, at) {
    await this.ensureRegistered()
    const result = await this.api.shareFile(this.ids, {
      topicId,
      kind: parentId === undefined ? 'post' : 'comment',
      parentId,
      requestId: this.requestId(),
      intro,
      fileSha256: sha256,
      fileSize: size,
      at,
    })
    return { id: result.id, duplicate: result.duplicate === true }
  }

  /**
   * @param {string} topicId
   * @param {number} messageId
   */
  async addHolder(topicId, messageId) {
    await this.ensureRegistered()
    await this.api.addHolder(this.ids, topicId, messageId)
  }

  /**
   * @param {string} topicId
   * @param {number} messageId
   */
  async removeHolder(topicId, messageId) {
    await this.ensureRegistered()
    await this.api.removeHolder(this.ids, topicId, messageId)
  }

  /** Stop delivery and release the registration. */
  async close() {
    if (this.closed) return
    this.closed = true
    this.paused = false
    this.connectionGeneration += 1
    this.connectionAbort.abort()
    if (this.timer !== undefined) clearTimeout(this.timer)
    if (this.ackTimer !== undefined) clearTimeout(this.ackTimer)
    this.abort.abort()
    try {
      await this.api.unregister(this.ids)
    } catch {
      // The server marks the mailbox inactive on its own timeout as well.
    }
  }
}
