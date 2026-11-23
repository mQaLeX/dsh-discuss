import { DEFAULTS } from '../../shared/constants.js'

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * One digest line for one delivered message.
 * @param {{ topicId: string, messageId: number, kind: string, author: string, text: string, fileSize: number | null, parentId: number | null, at?: string | null, toYou: boolean, mentionYou?: boolean }} message
 * @returns {string}
 */
export function formatLine(message) {
  const marker = message.parentId === null ? '' : ` -> ${message.parentId}`
  const attachment = message.fileSize === null ? '' : ` (file ${formatSize(message.fileSize)})`
  const at = typeof message.at === 'string' && message.at.length > 0 ? ` (at @${message.at})` : ''
  const toYou = message.toYou === true ? ' (to you)' : ''
  const mentionYou = message.mentionYou === true ? ' (mention you)' : ''
  // One message, one line: a newline in the body would otherwise let a peer
  // forge a second digest line with its own author and markers.
  const text = String(message.text ?? '').replaceAll(/[\r\n]+/g, ' ')
  return `- [${message.topicId}/${message.messageId}] @${message.author}${attachment}${marker}${at}${toYou}${mentionYou}: ${text}`
}

/**
 * Merge per-topic id ranges: adjacent or overlapping ids collapse into one
 * range, and ids never cross topics because every topic has its own counter.
 * @param {Array<{ topicId: string, from: number, to: number }>} ranges
 * @returns {Array<{ topicId: string, from: number, to: number }>}
 */
function mergeRanges(ranges) {
  /** @type {Map<string, Array<{ from: number, to: number }>>} */
  const byTopic = new Map()
  for (const range of ranges) {
    if (typeof range?.topicId !== 'string') continue
    if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.to < range.from) continue
    const list = byTopic.get(range.topicId)
    if (list === undefined) byTopic.set(range.topicId, [range])
    else list.push(range)
  }
  const merged = []
  for (const topicId of [...byTopic.keys()].sort()) {
    const list = byTopic.get(topicId).slice().sort((left, right) => left.from - right.from)
    let current = null
    for (const range of list) {
      if (current === null || range.from > current.to + 1) {
        if (current !== null) merged.push(current)
        current = { topicId, from: range.from, to: range.to }
      } else {
        current.to = Math.max(current.to, range.to)
      }
    }
    if (current !== null) merged.push(current)
  }
  return merged
}

/**
 * Show omitted ids as `topic/from-to`, capped so one digest line stays short.
 * @param {Array<{ topicId: string, from: number, to: number }>} ranges
 * @param {number} [limit]
 * @returns {string}
 */
export function formatOmittedRanges(ranges, limit = 8) {
  const shown = ranges.slice(0, limit).map(range => (
    range.from === range.to
      ? `${range.topicId}/${range.from}`
      : `${range.topicId}/${range.from}-${range.to}`
  ))
  if (ranges.length > shown.length) shown.push(`+${ranges.length - shown.length} more`)
  return shown.join(', ')
}

/**
 * @param {any[]} messages
 */
function rangesOf(messages) {
  return messages.map(message => ({ topicId: message.topicId, from: message.messageId, to: message.messageId }))
}

/**
 * Render one digest and report exactly which messages it kept. Only `retained`
 * should stay in memory: anything older is dropped and reachable through
 * `discuss_history`.
 *
 * The newest messages win the budget, then the rendered lines are emitted in
 * chronological order, so a long message can never push out fresher ones.
 * The omission line names the omitted ids per topic, because ids are allocated
 * per topic (contiguous within one topic, unrelated across topics).
 * @param {Array<any>} messages - candidates, oldest first.
 * @param {{
 *   maxMessages?: number,
 *   maxChars?: number,
 *   total?: number,
 *   omittedRanges?: Array<{ topicId: string, from: number, to: number }>,
 * }} [options]
 *   `total` counts messages already dropped before these candidates, so the
 *   header and the omission line still report the true batch size;
 *   `omittedRanges` describes those already-dropped messages.
 * @returns {{ text: string, shown: number, omitted: number, retained: any[], omittedRanges: Array<{ topicId: string, from: number, to: number }> }}
 */
export function renderDigest(messages, options = {}) {
  const maxMessages = options.maxMessages ?? DEFAULTS.digestMaxMessages
  const maxChars = options.maxChars ?? DEFAULTS.digestMaxChars
  const total = options.total ?? messages.length
  const extraRanges = Array.isArray(options.omittedRanges) ? options.omittedRanges : []
  const header = `[dsh-discuss] ${total} new message${total === 1 ? '' : 's'}`
  const candidates = messages.slice(-maxMessages)

  /** @param {any[]} included */
  const collectOmittedRanges = (included) => mergeRanges([
    ...extraRanges,
    ...rangesOf(messages.slice(0, messages.length - included.length)),
  ])

  const compose = (included, ranges) => {
    const lines = [header]
    const omitted = total - included.length
    if (omitted > 0) {
      const ids = ranges.length === 0 ? '' : ` (${formatOmittedRanges(ranges)})`
      lines.push(`(... ${omitted} earlier message${omitted === 1 ? '' : 's'} omitted${ids}; use discuss_history to read them)`)
    }
    for (const message of included) lines.push(formatLine(message))
    return lines.join('\n')
  }

  // Walk from the newest backwards so the freshest messages always win.
  let included = []
  let used = header.length
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const line = formatLine(candidates[index])
    // Reserve room for the omission line once anything will be left out.
    const reserve = total - (included.length + 1) > 0 ? 100 : 0
    if (used + line.length + 1 + reserve > maxChars) break
    included.unshift(candidates[index])
    used += line.length + 1
  }

  let ranges = collectOmittedRanges(included)
  let text = compose(included, ranges)
  while (text.length > maxChars && included.length > 0) {
    included = included.slice(1)
    ranges = collectOmittedRanges(included)
    text = compose(included, ranges)
  }
  return { text, shown: included.length, omitted: total - included.length, retained: included, omittedRanges: ranges }
}
