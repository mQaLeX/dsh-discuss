import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatLine, formatSize, renderDigest } from '../client/src/digest.js'

const post = {
  topicId: 'ab12cd',
  messageId: 41,
  kind: 'post',
  author: 'calm-otter-3f',
  text: 'build failed',
  fileSize: null,
  parentId: null,
  toYou: false,
}

const comment = {
  topicId: 'ab12cd',
  messageId: 42,
  kind: 'comment',
  author: 'brave-heron-2a',
  text: 'on it',
  fileSize: null,
  parentId: 41,
  toYou: true,
}

const file = {
  topicId: 'ab12cd',
  messageId: 43,
  kind: 'post',
  author: 'swift-ibis-7c',
  text: 'full log',
  fileSize: 1234,
  parentId: null,
  toYou: false,
}

test('formatSize is readable', () => {
  assert.equal(formatSize(12), '12 B')
  assert.equal(formatSize(2048), '2.0 KiB')
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MiB')
})

test('formatLine marks parent, attachment and direct replies', () => {
  assert.equal(formatLine(post), '- [ab12cd/41] @calm-otter-3f: build failed')
  assert.equal(formatLine(comment), '- [ab12cd/42] @brave-heron-2a -> 41 (to you): on it')
  assert.equal(formatLine(file), '- [ab12cd/43] @swift-ibis-7c (file 1.2 KiB): full log')
})

test('formatLine marks an at mention and the target flag', () => {
  assert.equal(
    formatLine({ ...post, at: 'brave-heron-2a' }),
    '- [ab12cd/41] @calm-otter-3f (at @brave-heron-2a): build failed',
  )
  assert.equal(
    formatLine({ ...post, at: 'calm-otter-3f', mentionYou: true }),
    '- [ab12cd/41] @calm-otter-3f (at @calm-otter-3f) (mention you): build failed',
  )
  assert.equal(
    formatLine({ ...comment, at: 'calm-otter-3f', mentionYou: true }),
    '- [ab12cd/42] @brave-heron-2a -> 41 (at @calm-otter-3f) (to you) (mention you): on it',
  )
})

test('renderDigest includes every message under the caps', () => {
  const rendered = renderDigest([post, comment, file], { maxMessages: 20, maxChars: 8000 })
  assert.equal(rendered.shown, 3)
  assert.equal(rendered.omitted, 0)
  assert.match(rendered.text, /^\[dsh-discuss\] 3 new messages/)
  assert.match(rendered.text, /ab12cd\/42/)
  assert.match(rendered.text, /\(to you\)/)
})

test('renderDigest keeps the newest messages and reports the omitted head', () => {
  const messages = Array.from({ length: 25 }, (_unused, index) => ({
    ...post,
    messageId: index + 1,
    text: `message ${index + 1}`,
  }))
  const rendered = renderDigest(messages, { maxMessages: 20, maxChars: 8000 })
  assert.equal(rendered.shown, 20)
  assert.equal(rendered.omitted, 5)
  assert.equal(rendered.retained.length, 20)
  assert.equal(rendered.retained[0].messageId, 6)
  assert.equal(rendered.retained[19].messageId, 25)
  assert.match(rendered.text, /message 6/)
  assert.doesNotMatch(rendered.text, /message 5\n/)
  assert.match(rendered.text, /5 earlier messages omitted \(ab12cd\/1-5\)/)
})

test('renderDigest names omitted ids per topic', () => {
  const messages = Array.from({ length: 5 }, (_unused, index) => ({
    ...post,
    messageId: 21 + index,
    text: `m${21 + index}`,
  }))
  const rendered = renderDigest(messages, {
    maxMessages: 20,
    maxChars: 8000,
    total: 25,
    omittedRanges: [{ topicId: 'ab12cd', from: 1, to: 20 }],
  })
  assert.equal(rendered.omitted, 20)
  assert.match(rendered.text, /20 earlier messages omitted \(ab12cd\/1-20\)/)
  assert.deepEqual(rendered.omittedRanges, [{ topicId: 'ab12cd', from: 1, to: 20 }])

  const mixed = renderDigest(
    [{ ...post, topicId: 'ab12cd', messageId: 10, text: 'latest' }],
    {
      maxMessages: 20,
      maxChars: 8000,
      total: 7,
      omittedRanges: [
        { topicId: 'ab12cd', from: 1, to: 2 },
        { topicId: 'ab12cd', from: 4, to: 5 },
        { topicId: 'ef34gh', from: 7, to: 8 },
      ],
    },
  )
  assert.match(mixed.text, /6 earlier messages omitted \(ab12cd\/1-2, ab12cd\/4-5, ef34gh\/7-8\)/)
})

test('renderDigest reports a total larger than the candidate list', () => {
  const messages = [post, comment]
  const rendered = renderDigest(messages, { maxMessages: 20, maxChars: 8000, total: 42 })
  assert.match(rendered.text, /^\[dsh-discuss\] 42 new messages/)
  assert.equal(rendered.shown, 2)
  assert.equal(rendered.omitted, 40)
  assert.equal(rendered.retained.length, 2)
})

test('renderDigest keeps the newest messages under a character cap', () => {
  const messages = Array.from({ length: 8 }, (_unused, index) => ({
    ...post,
    messageId: index + 1,
    text: `m${index + 1} ` + 'x'.repeat(100),
  }))
  const rendered = renderDigest(messages, { maxMessages: 20, maxChars: 400 })
  assert.ok(rendered.shown >= 1 && rendered.shown < 8)
  const retainedIds = rendered.retained.map(message => message.messageId)
  assert.deepEqual(retainedIds, Array.from({ length: rendered.shown }, (_unused, index) => 8 - rendered.shown + index + 1))
  assert.ok(rendered.text.length <= 400)
})

test('renderDigest respects the character cap', () => {
  const messages = Array.from({ length: 4 }, (_unused, index) => ({
    ...post,
    messageId: index + 1,
    text: 'x'.repeat(80),
  }))
  const rendered = renderDigest(messages, { maxMessages: 20, maxChars: 120 })
  assert.ok(rendered.text.length <= 400, 'header and omission line are bounded')
  assert.ok(rendered.omitted >= 1)
  assert.match(rendered.text, /more messages omitted|earlier messages omitted/)
})
