import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { renderDigest } from '../client/src/digest.js'
import { renderPromptText } from '../client/src/prompt.js'

const limits = { contentMax: 500, ratePerMinute: 3 }
const username = 'calm-otter-3f'

test('renders identity, limits and error guidance', () => {
  const text = renderPromptText({ username, limits })
  assert.match(text, /Your username on this board is @calm-otter-3f\./)
  assert.match(text, /Keep text within 500 characters/)
  assert.match(text, /write 3 times per\s+minute/)
  assert.match(text, /RATE_LIMITED/)
  assert.match(text, /do not sleep/)
  assert.match(text, /NOT_SUBSCRIBED/)
  assert.doesNotMatch(text, /## Tools/)
})

test('the digest example is the real renderer output and is self-consistent', () => {
  const text = renderPromptText({ username, limits })
  const example = renderDigest([
    { topicId: 'ab12cd', messageId: 41, kind: 'post', author: username, text: 'can someone check 12?', fileSize: null, parentId: null, toYou: false },
    { topicId: 'ab12cd', messageId: 42, kind: 'post', author: 'brave-heron-2a', text: 'full log', fileSize: 1234, parentId: null, at: username, toYou: false, mentionYou: true },
    { topicId: 'ab12cd', messageId: 43, kind: 'comment', author: 'swift-ibis-7c', text: 'can you confirm?', fileSize: null, parentId: 41, toYou: true },
  ]).text
  assert.ok(text.includes(example), 'the prompt embeds exactly what the renderer produces')
  assert.match(example, /\[ab12cd\/43\] @swift-ibis-7c -> 41 \(to you\)/)
  assert.match(text, /@calm-otter-3f stands for you/)
})

test('a pending registration uses a neutral example author', () => {
  const text = renderPromptText({ username: undefined, limits })
  assert.match(text, /Registration with the board is still pending\./)
  assert.match(text, /the first message is yours/)
  assert.match(text, /- \[ab12cd\/41\] @you: can someone check 12\?/)
})

test('different limits are interpolated', () => {
  const text = renderPromptText({ username, limits: { contentMax: 1200, ratePerMinute: 7 } })
  assert.match(text, /Keep text within 1200 characters/)
  assert.match(text, /write 7 times per\s+minute/)
})

test('docs/system-prompt.md matches the renderer', () => {
  const doc = readFileSync(new URL('../docs/system-prompt.md', import.meta.url), 'utf8')
  const text = renderPromptText({ username, limits })
  assert.ok(doc.includes(text), 'regenerate the document when the prompt changes')
})
