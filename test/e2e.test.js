import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createTopics, openStream, post, register, startStack, subscribe } from './helpers.js'

/**
 * @param {Awaited<ReturnType<typeof startStack>>} stack
 * @param {string} topicId
 * @param {{ installationId: string, sessionId: string }} ids
 */
async function history(stack, topicId, ids) {
  const response = await fetch(
    `${stack.base}/v1/history/${topicId}?installationId=${encodeURIComponent(ids.installationId)}&sessionId=${encodeURIComponent(ids.sessionId)}`,
  )
  assert.equal(response.status, 200)
  return (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

test('a board restart preserves topics, subscriptions, messages and unacked mail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discuss-e2e-'))
  const a = { installationId: 'restart-host', sessionId: 'a' }
  const b = { installationId: 'restart-host', sessionId: 'b' }
  let stack
  let stream
  try {
    stack = await startStack({ ratePerMinute: 100 }, { dir })
    const [topic] = await createTopics(stack.adminBase, ['restart topic'])
    for (const ids of [a, b]) {
      await register(stack.base, ids.installationId, ids.sessionId)
      await subscribe(stack.base, ids, topic.id)
    }
    const first = await post(stack.base, a, topic.id, 'before restart')
    assert.equal(first.status, 200)
    const before = await history(stack, topic.id, a)
    assert.equal(before.length, 1)

    // B has never connected, so its mail is still unacked in the database.
    await stack.close({ keepDir: true })

    stack = await startStack({ ratePerMinute: 100 }, { dir })
    const topicsResponse = await fetch(
      `${stack.base}/v1/topics?installationId=${encodeURIComponent(a.installationId)}&sessionId=${encodeURIComponent(a.sessionId)}`,
    )
    const topics = await topicsResponse.json()
    assert.ok(topics.subscribed.some(item => item.id === topic.id), 'subscription survives the restart')

    const after = await history(stack, topic.id, a)
    assert.deepEqual(after.map(row => row.id), before.map(row => row.id))
    assert.equal(after[0].text, 'before restart')

    const next = await post(stack.base, a, topic.id, 'after restart')
    assert.equal(next.status, 200)
    assert.ok(next.body.id > first.body.id)

    // B's pre-restart unacked mail is replayed by the gateway after the restart.
    stream = openStream(`${stack.base}/v1/gateway?installationId=${b.installationId}&sessionId=${b.sessionId}`)
    const delivery = await stream.next(event => (
      event.type === 'delivery'
      && event.messages.some(message => message.messageId === first.body.id)
    ))
    assert.ok(delivery.messages.some(message => message.text === 'before restart'))
  } finally {
    stream?.close()
    await stack?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
