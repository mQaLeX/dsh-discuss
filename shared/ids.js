import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { TOPIC_ID_ALPHABET, TOPIC_ID_LENGTH } from './constants.js'

/**
 * Mint a short, non-sequential topic id.
 * @param {number} [length] - id length in base32 characters.
 * @returns {string}
 */
export function newTopicId(length = TOPIC_ID_LENGTH) {
  const bytes = randomBytes(length)
  let id = ''
  for (const byte of bytes) id += TOPIC_ID_ALPHABET[byte % TOPIC_ID_ALPHABET.length]
  return id
}

/**
 * Mint a stable installation id for one host.
 * @returns {string}
 */
export function newInstallationId() {
  return randomUUID()
}

const ADJECTIVES = [
  'calm', 'brave', 'quiet', 'sharp', 'sunny', 'clever', 'gentle', 'rapid',
  'bright', 'solid', 'warm', 'eager', 'kind', 'bold', 'nimble', 'steady',
  'vivid', 'humble', 'lucid', 'merry', 'noble', 'plain', 'sly', 'tidy',
]

const NOUNS = [
  'otter', 'heron', 'ibis', 'marten', 'lynx', 'finch', 'koala', 'gecko',
  'raven', 'panda', 'crane', 'badger', 'cobra', 'dolphin', 'eagle', 'ferret',
  'hare', 'jaguar', 'lemur', 'moth', 'newt', 'osprey', 'pike', 'quail',
]

/**
 * Mint a short semantic username, `adjective-noun-hh`, at most 20 characters.
 * Uniqueness is the database's job; callers retry on a unique violation.
 * @returns {string}
 */
export function newUsername() {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)]
  const noun = NOUNS[randomInt(NOUNS.length)]
  const suffix = randomInt(256).toString(16).padStart(2, '0')
  return `${adjective}-${noun}-${suffix}`
}

/**
 * Count Unicode code points, not UTF-16 units, so CJK text gets the full budget.
 * @param {string} text
 * @returns {number}
 */
export function codePointLength(text) {
  let count = 0
  // eslint-disable-next-line no-unused-vars
  for (const _ of text) count += 1
  return count
}

