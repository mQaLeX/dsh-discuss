import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createTopics, post, register, request, startStack, subscribe } from './helpers.js'
import { openDatabase, tx } from '../server/db.js'
import { createDiscussServer } from '../server/http.js'
import { createTopic, pendingMail } from '../server/store.js'

/** @type {Awaited<ReturnType<typeof startStack>>} */
let stack
let topicId

before(async () => {
  stack = await startStack({ ratePerMinute: 1000, contentMax: 200 })
  const [topic] = await createTopics(stack.adminBase, ['concurrency'])
  topicId = topic.id
})

after(async () => {
  await stack.close()
})

test('parallel posts allocate unique contiguous ids', async () => {
  const sessions = ['c1', 'c2', 'c3', 'c4'].map(id => ({ installationId: 'conc', sessionId: id }))
  for (const ids of sessions) {
    await register(stack.base, ids.installationId, ids.sessionId)
    await subscribe(stack.base, ids, topicId)
  }
  const results = await Promise.all(
    Array.from({ length: 40 }, (_unused, index) => post(
      stack.base,
      sessions[index % sessions.length],
      topicId,
      `parallel ${index}`,
    )),
  )
  assert.ok(results.every(result => result.status === 200), JSON.stringify(results.filter(r => r.status !== 200)))
  const ids = results.map(result => result.body.id)
  assert.equal(new Set(ids).size, 40, 'every id is distinct')
  assert.equal(Math.min(...ids), 1)
  assert.equal(Math.max(...ids), 40)
})

test('parallel retries with one request id create one row', async () => {
  const ids = { installationId: 'conc', sessionId: 'c1' }
  const requestId = 'same-request-42'
  const results = await Promise.all(
    Array.from({ length: 20 }, () => post(stack.base, ids, topicId, 'retry storm', { requestId })),
  )
  assert.ok(results.every(result => result.status === 200))
  assert.equal(new Set(results.map(result => result.body.id)).size, 1)
  const row = stack.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE request_id = ?').get(requestId)
  assert.equal(row.count, 1)
})

test('parallel comments from one session on one parent create one row', async () => {
  const ids = { installationId: 'conc', sessionId: 'c2' }
  const root = await post(stack.base, ids, topicId, 'comment root')
  const results = await Promise.all(
    Array.from({ length: 10 }, (_unused, index) => post(
      stack.base,
      ids,
      topicId,
      `answer ${index}`,
      { parentId: root.body.id },
    )),
  )
  assert.ok(results.every(result => result.status === 200))
  assert.equal(new Set(results.map(result => result.body.id)).size, 1)
  const row = stack.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE parent_id = ?').get(root.body.id)
  assert.equal(row.count, 1)
})

test('parallel comments from different sessions on one parent all land', async () => {
  const root = await post(stack.base, { installationId: 'conc', sessionId: 'c3' }, topicId, 'many replies')
  const speakers = Array.from({ length: 8 }, (_unused, index) => ({ installationId: 'many', sessionId: `s${index}` }))
  for (const ids of speakers) {
    await register(stack.base, ids.installationId, ids.sessionId)
    await subscribe(stack.base, ids, topicId)
  }
  const results = await Promise.all(
    speakers.map((ids, index) => post(stack.base, ids, topicId, `reply ${index}`, { parentId: root.body.id })),
  )
  assert.ok(results.every(result => result.status === 200))
  assert.equal(new Set(results.map(result => result.body.id)).size, 8)
})

test('parallel registrations of one pair mint one username', async () => {
  const results = await Promise.all(
    Array.from({ length: 50 }, () => register(stack.base, 'same-host', 'same-session')),
  )
  assert.ok(results.every(result => result.status === 200))
  assert.equal(new Set(results.map(result => result.body.username)).size, 1)
  const row = stack.db.prepare(`SELECT COUNT(*) AS count FROM sessions
    WHERE installation_id = 'same-host' AND session_id = 'same-session'`).get()
  assert.equal(row.count, 1)
})

test('parallel acks drain the mailbox once', async () => {
  const a = { installationId: 'ack-host', sessionId: 'a' }
  const b = { installationId: 'ack-host', sessionId: 'b' }
  for (const ids of [a, b]) {
    await register(stack.base, ids.installationId, ids.sessionId)
    await subscribe(stack.base, ids, topicId)
  }
  for (let index = 0; index < 10; index += 1) await post(stack.base, a, topicId, `mail ${index}`)
  const rows = pendingMail(stack.db, b)
  assert.equal(rows.length, 10)
  const half = rows.slice(0, 5).map(row => row.seq)
  const rest = rows.slice(5).map(row => row.seq)
  const results = await Promise.all([
    request(`${stack.base}/v1/ack`, { ...b, mailIds: half }),
    request(`${stack.base}/v1/ack`, { ...b, mailIds: rest }),
    request(`${stack.base}/v1/ack`, { ...b, mailIds: half }),
    request(`${stack.base}/v1/ack`, { ...b, mailIds: rest }),
  ])
  assert.ok(results.every(result => result.status === 200))
  assert.deepEqual(pendingMail(stack.db, b), [])
  const acked = stack.db.prepare(`SELECT COUNT(*) AS count FROM mailbox
    WHERE installation_id = 'ack-host' AND session_id = 'b' AND acked_at IS NOT NULL`).get()
  assert.equal(acked.count, 10)
})

test('parallel subscription churn ends consistent', async () => {
  const ids = { installationId: 'churn', sessionId: 'a' }
  await register(stack.base, ids.installationId, ids.sessionId)
  await Promise.all(Array.from({ length: 30 }, (_unused, index) => subscribe(stack.base, ids, topicId, index % 2 === 0)))
  await subscribe(stack.base, ids, topicId, true)
  const topics = await request(`${stack.base}/v1/topics?installationId=churn&sessionId=a`, undefined, 'GET')
  assert.ok(topics.body.subscribed.some(topic => topic.id === topicId))
  const posted = await post(stack.base, ids, topicId, 'after churn')
  assert.equal(posted.status, 200)
})

test('two discuss servers on one database never collide', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discuss-multi-'))
  const dbPath = join(dir, 'multi.db')
  const dbOne = openDatabase(dbPath)
  const dbTwo = openDatabase(dbPath)
  const config = { ratePerMinute: 1000, contentMax: 200, retryAfterMs: 5000, heartbeatMs: 5000 }
  const one = createDiscussServer({ db: dbOne, dataDir: dir, config })
  const two = createDiscussServer({ db: dbTwo, dataDir: dir, config })
  await new Promise(resolve => one.server.listen(0, '127.0.0.1', resolve))
  await new Promise(resolve => two.server.listen(0, '127.0.0.1', resolve))
  const baseOne = `http://127.0.0.1:${one.server.address().port}`
  const baseTwo = `http://127.0.0.1:${two.server.address().port}`
  try {
    const topic = tx(dbOne, () => createTopic(dbOne, 'two processes'))
    const ids = { installationId: 'multi', sessionId: 's' }
    await register(baseOne, ids.installationId, ids.sessionId)
    await subscribe(baseOne, ids, topic.id)
    const results = await Promise.all(
      Array.from({ length: 30 }, (_unused, index) => post(
        index % 2 === 0 ? baseOne : baseTwo,
        ids,
        topic.id,
        `split ${index}`,
      )),
    )
    assert.ok(results.every(result => result.status === 200), JSON.stringify(results.filter(r => r.status !== 200)))
    const messageIds = results.map(result => result.body.id)
    assert.equal(new Set(messageIds).size, 30)
    assert.deepEqual([...messageIds].sort((left, right) => left - right), Array.from({ length: 30 }, (_unused, index) => index + 1))

    // Two processes racing to register the same (installation, session) pair
    // must agree on one username.
    const raced = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) => register(
        index % 2 === 0 ? baseOne : baseTwo,
        'multi-host',
        'same-session',
      )),
    )
    assert.ok(raced.every(result => result.status === 200), JSON.stringify(raced.filter(r => r.status !== 200)))
    assert.equal(new Set(raced.map(result => result.body.username)).size, 1)
    const row = dbOne.prepare(`SELECT COUNT(*) AS count FROM sessions
      WHERE installation_id = 'multi-host' AND session_id = 'same-session'`).get()
    assert.equal(row.count, 1)
  } finally {
    await one.close().catch(() => {})
    await two.close().catch(() => {})
    dbOne.close()
    dbTwo.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent subscribe and post never corrupts routing', async () => {
  const speakers = Array.from({ length: 6 }, (_unused, index) => ({ installationId: 'churn2', sessionId: `s${index}` }))
  for (const ids of speakers) await register(stack.base, ids.installationId, ids.sessionId)
  await Promise.all(speakers.map(ids => subscribe(stack.base, ids, topicId, true)))

  // Half the sessions keep posting while half churn their subscription.
  const posting = speakers.slice(0, 3).map((ids, index) => post(stack.base, ids, topicId, `steady ${index}`))
  const churning = speakers.slice(3).map(async (ids) => {
    await subscribe(stack.base, ids, topicId, false)
    const denied = await post(stack.base, ids, topicId, 'after unsubscribe')
    await subscribe(stack.base, ids, topicId, true)
    return denied
  })
  const [posted, denied] = await Promise.all([Promise.all(posting), Promise.all(churning)])
  assert.ok(posted.every(result => result.status === 200))
  assert.ok(denied.every(result => result.status === 403 && result.body.error.code === 'NOT_SUBSCRIBED'))
  const topics = await request(`${stack.base}/v1/topics?installationId=churn2&sessionId=s3`, undefined, 'GET')
  assert.equal(topics.status, 200)
})

test('mixed admin topic creation and posting stays healthy', async () => {
  const ids = { installationId: 'mixed', sessionId: 's' }
  await register(stack.base, ids.installationId, ids.sessionId)
  await subscribe(stack.base, ids, topicId)
  // The admin token is single-slot by design, so creations take turns while
  // posts keep flowing through the other connection.
  const writings = Promise.all(
    Array.from({ length: 20 }, (_unused, index) => post(stack.base, ids, topicId, `mixed write ${index}`)),
  )
  const creations = (async () => {
    for (let index = 0; index < 5; index += 1) {
      const created = await createTopics(stack.adminBase, [`mixed ${Date.now()}-${index}`])
      assert.equal(created.length, 1)
    }
  })()
  const [results] = await Promise.all([writings, creations])
  assert.ok(results.every(result => result.status === 200))
})
