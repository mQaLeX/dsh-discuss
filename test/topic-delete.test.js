import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { startStack, createTopics, register, request, subscribe } from './helpers.js'
import { deleteTopic, topicCensus } from '../server/store.js'

test('deleting a topic removes every row it owns and nothing else', async () => {
  const stack = await startStack({ ratePerMinute: 100 })
  const [keep, doomed] = await createTopics(stack.adminBase, ['keep me', 'delete me'])
  const a = { installationId: 'del-host', sessionId: 'del-a' }
  const b = { installationId: 'del-host', sessionId: 'del-b' }

  try {
    for (const ids of [a, b]) {
      await register(stack.base, ids.installationId, ids.sessionId)
      await subscribe(stack.base, ids, doomed.id)
      await subscribe(stack.base, ids, keep.id)
    }
    const root = await request(`${stack.base}/v1/messages`, {
      ...a, topicId: doomed.id, kind: 'post', requestId: crypto.randomUUID(), text: 'one',
    })
    assert.equal(root.status, 200)
    const reply = await request(`${stack.base}/v1/messages`, {
      ...b, topicId: doomed.id, kind: 'comment', parentId: root.body.id,
      requestId: crypto.randomUUID(), text: 'two',
    })
    assert.equal(reply.status, 200)
    await request(`${stack.base}/v1/messages`, {
      ...a, topicId: keep.id, kind: 'post', requestId: crypto.randomUUID(), text: 'safe',
    })

    const census = topicCensus(stack.db, doomed.id)
    assert.equal(census.name, 'delete me')
    assert.equal(census.messages, 2)
    assert.equal(census.subscriptions, 2)
    assert.ok(census.mailbox >= 2, 'queued mail is counted')
    assert.equal(census.holders, 0)
    assert.equal(topicCensus(stack.db, keep.id).messages, 1)

    const removed = deleteTopic(stack.db, doomed.id)
    assert.equal(removed.id, doomed.id)
    assert.equal(removed.messages, 2)

    // The topic, its messages, subscriptions and queued mail are gone.
    assert.equal(
      stack.db.prepare('SELECT COUNT(*) AS n FROM topics WHERE id = ?').get(doomed.id).n, 0,
    )
    assert.equal(
      stack.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE topic_id = ?').get(doomed.id).n, 0,
    )
    assert.equal(
      stack.db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE topic_id = ?').get(doomed.id).n, 0,
    )
    assert.equal(
      stack.db.prepare('SELECT COUNT(*) AS n FROM mailbox WHERE topic_id = ?').get(doomed.id).n, 0,
    )

    // The other topic and its mail are untouched.
    assert.equal(topicCensus(stack.db, keep.id).messages, 1)
    assert.ok(topicCensus(stack.db, keep.id).mailbox >= 1)

    // The board answers as if the topic never existed.
    const gone = await fetch(`${stack.base}/v1/history/${doomed.id}?installationId=del-host&sessionId=del-a`)
    assert.equal(gone.status, 404)
    assert.equal((await gone.json()).error.code, 'TOPIC_NOT_FOUND')
    assert.throws(() => deleteTopic(stack.db, doomed.id), /does not exist/)
  } finally {
    await stack.close()
  }
})

test('a topic that still owns file holders loses them too', async () => {
  const stack = await startStack({ ratePerMinute: 100 })
  const [topic] = await createTopics(stack.adminBase, ['holders'])
  const a = { installationId: 'hold-host', sessionId: 'hold-a' }
  try {
    await register(stack.base, a.installationId, a.sessionId)
    await subscribe(stack.base, a, topic.id)
    stack.db.prepare(`INSERT INTO holders (topic_id, message_id, installation_id, active, last_seen_at)
      VALUES (?, 1, ?, 1, ?)`).run(topic.id, a.installationId, Date.now())
    assert.equal(topicCensus(stack.db, topic.id).holders, 1)
    deleteTopic(stack.db, topic.id)
    assert.equal(
      stack.db.prepare('SELECT COUNT(*) AS n FROM holders WHERE topic_id = ?').get(topic.id).n, 0,
    )
  } finally {
    await stack.close()
  }
})

test('the maintenance cli deletes only after two y answers', async () => {
  const stack = await startStack({ ratePerMinute: 100 })
  const [doomed, kept] = await createTopics(stack.adminBase, ['cli delete', 'cli keep'])
  const config = join(stack.dir, 'cli-config.json')
  writeFileSync(config, JSON.stringify({ dbPath: join(stack.dir, 'discuss.db') }))
  const cli = join(import.meta.dirname, '..', 'server', 'bin-topic.js')
  const run = (args, input) => spawnSync(process.execPath, [cli, ...args, '--config', config], {
    encoding: 'utf8',
    input,
  })
  const rows = id => stack.db.prepare('SELECT COUNT(*) AS n FROM topics WHERE id = ?').get(id).n
  try {
    const listed = run(['list'], '')
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, new RegExp(doomed.id))

    // One y is not enough, and end of input cancels without touching the row.
    const half = run(['delete', doomed.id], 'y\nn\n')
    assert.equal(half.status, 2)
    assert.match(half.stdout, /not confirmed/)
    const eof = run(['delete', doomed.id], '')
    assert.equal(eof.status, 2)
    assert.equal(rows(doomed.id), 1)

    // The old --yes flag is refused instead of bypassing the questions.
    const legacy = run(['delete', doomed.id, '--yes'], '')
    assert.equal(legacy.status, 2)
    assert.match(legacy.stderr, /--yes is gone/)

    const deleted = run(['delete', doomed.id], 'y\ny\n')
    assert.equal(deleted.status, 0, deleted.stderr)
    assert.match(deleted.stdout, new RegExp(`deleted topic ${doomed.id} "cli delete"`))
    assert.equal(rows(doomed.id), 0)
    assert.equal(rows(kept.id), 1)
  } finally {
    await stack.close()
  }
})
