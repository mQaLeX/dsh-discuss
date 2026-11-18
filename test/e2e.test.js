import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DiscussApi } from '../client/src/api.js'
import { SessionClient } from '../client/src/core.js'
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

/** @param {() => boolean} check */
async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
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

test('a client on a rebuilt board re-registers and adopts the new username', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discuss-identity-'))
  const ids = { installationId: 'identity-host', sessionId: 'identity-session' }
  let stack
  let client
  try {
    stack = await startStack({ ratePerMinute: 100 }, { dir })
    const [topic] = await createTopics(stack.adminBase, ['identity topic'])
    const port = stack.discuss.server.address().port
    const api = new DiscussApi({ baseUrl: stack.base, timeoutMs: 2_000 })
    client = new SessionClient({
      ids,
      api,
      agent: { status: 'idle', inject: () => {}, inbox: { remove: () => false } },
      spool: { append: () => {}, replace: () => {}, load: () => [], clear: () => {} },
      makeMessage: (text, count) => ({ id: 'digest', text, count }),
      config: { coalesceMs: 15_000, mergeThrottleMs: 30_000, digestMaxMessages: 20, digestMaxChars: 8_000 },
      logger: { warn: () => {} },
    })
    client.start()
    await waitFor(() => client.username !== undefined && client.connected)
    await client.setSubscription(topic.id, true)
    const before = client.username
    const first = await client.post(topic.id, 'before the wipe')
    const rows = await history(stack, topic.id, ids)
    assert.equal(rows.find(row => row.id === first).user, before)

    // The board is redeployed onto an empty database while the client keeps
    // running: same address, same ids, no session row. The client must notice
    // the lost row and adopt the username the rebuilt board mints for it.
    await stack.close({ keepDir: true })
    for (const suffix of ['', '-wal', '-shm']) rmSync(join(dir, `discuss.db${suffix}`), { force: true })
    stack = await startStack({ ratePerMinute: 100 }, { dir, port })
    const [fresh] = await createTopics(stack.adminBase, ['identity topic after the wipe'])

    await waitFor(() => client.connected && client.username !== before)
    await client.setSubscription(fresh.id, true)
    const after = await client.post(fresh.id, 'after the wipe')
    const freshRows = await history(stack, fresh.id, ids)
    assert.equal(freshRows.find(row => row.id === after).user, client.username)
    assert.notEqual(client.username, before)
  } finally {
    await client?.close().catch(() => {})
    await stack?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
