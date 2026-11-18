import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createTopics, fakeHolder, openStream, post, register, request, startStack, subscribe } from './helpers.js'
import { dashboardData, listHolders, pendingMail } from '../server/store.js'

/** @type {Awaited<ReturnType<typeof startStack>>} */
let stack
let topicId

before(async () => {
  stack = await startStack({ contentMax: 60, ratePerMinute: 6, fileMaxBytes: 1024 * 1024 })
  const [topic] = await createTopics(stack.adminBase, ['server tests'])
  topicId = topic.id
})

after(async () => {
  await stack.close()
})

test('register mints one stable username per session', async () => {
  const first = await register(stack.base, 'install-1', 'session-a')
  assert.equal(first.status, 200)
  const again = await register(stack.base, 'install-1', 'session-a')
  assert.equal(again.body.username, first.body.username)
  const other = await register(stack.base, 'install-1', 'session-b')
  assert.notEqual(other.body.username, first.body.username)
  const otherHost = await register(stack.base, 'install-2', 'session-a')
  assert.notEqual(otherHost.body.username, first.body.username)
})

test('admin create is idempotent and reports created/existing', async () => {
  const requestToken = await request(`${stack.adminBase}/v1/admin/topics/request`, {})
  assert.equal(requestToken.status, 200)
  assert.ok(Array.isArray(requestToken.body.topics))
  const confirmed = await request(`${stack.adminBase}/v1/admin/topics/confirm`, {
    token: requestToken.body.token,
    names: ['alpha topic', 'beta topic', 'alpha topic'],
  })
  assert.equal(confirmed.status, 200)
  assert.deepEqual(confirmed.body.results.map(row => row.status), ['created', 'created', 'existing'])
  assert.equal(confirmed.body.results[0].id, confirmed.body.results[2].id)

  const second = await request(`${stack.adminBase}/v1/admin/topics/request`, {})
  const again = await request(`${stack.adminBase}/v1/admin/topics/confirm`, {
    token: second.body.token,
    names: ['alpha topic'],
  })
  assert.deepEqual(again.body.results.map(row => row.status), ['existing'])
})

test('post, comment, history and thread export', async () => {
  const a = { installationId: 'h1', sessionId: 'a' }
  const b = { installationId: 'h1', sessionId: 'b' }
  await register(stack.base, a.installationId, a.sessionId)
  await register(stack.base, b.installationId, b.sessionId)
  await subscribe(stack.base, a, topicId)
  await subscribe(stack.base, b, topicId)

  const first = await post(stack.base, a, topicId, 'first post')
  assert.equal(first.status, 200)
  const second = await post(stack.base, b, topicId, 'second post')
  assert.equal(second.body.id, first.body.id + 1)

  const comment = await post(stack.base, b, topicId, 'answer', { parentId: first.body.id })
  assert.equal(comment.status, 200)

  const history = await fetch(`${stack.base}/v1/history/${topicId}?installationId=h1&sessionId=a`)
  assert.equal(history.status, 200)
  const lines = (await history.text()).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(lines.length, 3)
  assert.deepEqual(lines.map(line => line.kind), ['post', 'post', 'comment'])
  assert.equal(lines[2].parent, first.body.id)

  const thread = await fetch(`${stack.base}/v1/query/${topicId}/${first.body.id}?installationId=h1&sessionId=a`)
  const threadLines = (await thread.text()).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(threadLines.map(line => line.id), [first.body.id, comment.body.id])

  const wholeThread = await fetch(`${stack.base}/v1/query/${topicId}/${comment.body.id}?installationId=h1&sessionId=a`)
  const wholeLines = (await wholeThread.text()).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(wholeLines.map(line => line.id), [first.body.id, comment.body.id])
})

test('comment is idempotent per session and parent', async () => {
  const a = { installationId: 'h2', sessionId: 'a' }
  await register(stack.base, a.installationId, a.sessionId)
  await subscribe(stack.base, a, topicId)
  const post1 = await post(stack.base, a, topicId, 'root')
  const one = await post(stack.base, a, topicId, 'note', { parentId: post1.body.id })
  const two = await post(stack.base, a, topicId, 'different text', { parentId: post1.body.id })
  assert.equal(one.body.id, two.body.id)
  assert.equal(two.body.duplicate, true)
})

test('request id makes writes idempotent', async () => {
  const a = { installationId: 'h3', sessionId: 'a' }
  await register(stack.base, a.installationId, a.sessionId)
  await subscribe(stack.base, a, topicId)
  const requestId = 'fixed-request-id'
  const first = await post(stack.base, a, topicId, 'once', { requestId })
  const second = await post(stack.base, a, topicId, 'once', { requestId })
  assert.equal(first.body.id, second.body.id)
  assert.equal(second.body.duplicate, true)
})

test('writes require a subscription', async () => {
  const outsider = { installationId: 'h4', sessionId: 'a' }
  await register(stack.base, outsider.installationId, outsider.sessionId)
  const denied = await post(stack.base, outsider, topicId, 'hello')
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error.code, 'NOT_SUBSCRIBED')

  const history = await fetch(`${stack.base}/v1/history/${topicId}?installationId=h4&sessionId=a`)
  assert.equal(history.status, 403)
})

test('content limits and empty text', async () => {
  const a = { installationId: 'h5', sessionId: 'a' }
  await register(stack.base, a.installationId, a.sessionId)
  await subscribe(stack.base, a, topicId)
  const empty = await post(stack.base, a, topicId, '   ')
  assert.equal(empty.status, 400)
  assert.equal(empty.body.error.code, 'CONTENT_EMPTY')
  const long = await post(stack.base, a, topicId, 'x'.repeat(61))
  assert.equal(long.status, 400)
  assert.equal(long.body.error.code, 'CONTENT_TOO_LONG')
  const cjk = await post(stack.base, a, topicId, '汉'.repeat(60))
  assert.equal(cjk.status, 200, 'CJK counts as code points, not bytes')
})

test('rate limit is shared by posts and comments', async () => {
  const a = { installationId: 'h6', sessionId: 'a' }
  await register(stack.base, a.installationId, a.sessionId)
  await subscribe(stack.base, a, topicId)
  const results = []
  for (let index = 0; index < 6; index += 1) results.push(await post(stack.base, a, topicId, `m${index}`))
  assert.ok(results.every(result => result.status === 200))
  const blocked = await post(stack.base, a, topicId, 'one too many')
  assert.equal(blocked.status, 429)
  assert.equal(blocked.body.error.code, 'RATE_LIMITED')
  assert.ok(blocked.body.error.retryAfterSeconds >= 1)
  assert.equal(Number.isInteger(blocked.body.error.retryAfterSeconds), true)
  assert.equal('retryAfterMs' in blocked.body.error, false)

  // The standard header carries the same integer seconds.
  const raw = await fetch(`${stack.base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...a, topicId, kind: 'post', requestId: crypto.randomUUID(), text: 'still blocked',
    }),
  })
  assert.equal(raw.status, 429)
  const rawBody = await raw.json()
  assert.equal(rawBody.error.code, 'RATE_LIMITED')
  assert.equal(raw.headers.get('retry-after'), String(rawBody.error.retryAfterSeconds))
})

test('rejected and idempotent writes do not consume rate-limit slots', async () => {
  const tight = await startStack({ ratePerMinute: 3, contentMax: 60 })
  try {
    const [topic] = await createTopics(tight.adminBase, ['slot accounting'])
    const a = { installationId: 'slot-host', sessionId: 'a' }
    await register(tight.base, a.installationId, a.sessionId)
    await subscribe(tight.base, a, topic.id)

    // A rejected request is validated before the slot is charged.
    const badParent = await post(tight.base, a, topic.id, 'bad parent', { parentId: 999_999 })
    assert.equal(badParent.status, 404)
    assert.equal(badParent.body.error.code, 'PARENT_NOT_FOUND')

    // requestId and comment replays resolve before the slot is charged too.
    const requestId = 'slot-request'
    const first = await post(tight.base, a, topic.id, 'first', { requestId })
    assert.equal(first.status, 200)
    const replay = await post(tight.base, a, topic.id, 'first again', { requestId })
    assert.equal(replay.body.duplicate, true)
    assert.equal(replay.body.id, first.body.id)

    const comment = await post(tight.base, a, topic.id, 'note', { parentId: first.body.id })
    assert.equal(comment.status, 200)
    const commentReplay = await post(tight.base, a, topic.id, 'another note', { parentId: first.body.id })
    assert.equal(commentReplay.body.duplicate, true)
    assert.equal(commentReplay.body.id, comment.body.id)

    // Two real writes used two slots; rejected and replayed writes charged none,
    // so the third real write must still pass and the fourth must be blocked.
    const last = await post(tight.base, a, topic.id, 'last')
    assert.equal(last.status, 200, 'rejected and replayed writes must not consume slots')
    const blocked = await post(tight.base, a, topic.id, 'one too many')
    assert.equal(blocked.status, 429)
    assert.equal(blocked.body.error.code, 'RATE_LIMITED')

    // NOT_SUBSCRIBED is rejected before the slot as well.
    const outsider = { installationId: 'slot-host', sessionId: 'b' }
    await register(tight.base, outsider.installationId, outsider.sessionId)
    const denied = await post(tight.base, outsider, topic.id, 'not subscribed')
    assert.equal(denied.status, 403)
    assert.equal(denied.body.error.code, 'NOT_SUBSCRIBED')
    await subscribe(tight.base, outsider, topic.id)
    for (let index = 0; index < 3; index += 1) {
      const allowed = await post(tight.base, outsider, topic.id, `b${index}`)
      assert.equal(allowed.status, 200)
    }
    const blockedOutsider = await post(tight.base, outsider, topic.id, 'b too many')
    assert.equal(blockedOutsider.status, 429)
  } finally {
    await tight.close()
  }
})

test('file messages relay bytes from an online holder', async () => {
  const topic = (await createTopics(stack.adminBase, ['relay topic']))[0]
  const holder = { installationId: 'relay-host', sessionId: 'a' }
  const peer = { installationId: 'relay-peer', sessionId: 'b' }
  for (const ids of [holder, peer]) {
    await register(stack.base, ids.installationId, ids.sessionId)
    await subscribe(stack.base, ids, topic.id)
  }
  const bytes = Buffer.from('#!/bin/sh\necho hi\n')
  const sha = createHash('sha256').update(bytes).digest('hex')
  const shared = await request(`${stack.base}/v1/messages/file`, {
    ...holder,
    topicId: topic.id,
    kind: 'post',
    requestId: crypto.randomUUID(),
    intro: 'helper script',
    fileSha256: sha,
    fileSize: bytes.length,
  })
  assert.equal(shared.status, 200)
  const messageId = shared.body.id
  assert.deepEqual(listHolders(stack.db, topic.id, messageId), ['relay-host'])

  const offline = await fetch(`${stack.base}/v1/files/${topic.id}/${messageId}?installationId=relay-peer&sessionId=b`)
  assert.equal(offline.status, 503)
  assert.equal((await offline.json()).error.code, 'FILE_UNAVAILABLE')

  const holderClient = fakeHolder({
    base: stack.base,
    installationId: 'relay-host',
    files: new Map([[`${topic.id}/${messageId}`, bytes]]),
  })
  await holderClient.ready
  try {
    const download = await fetch(`${stack.base}/v1/files/${topic.id}/${messageId}?installationId=relay-peer&sessionId=b`)
    assert.equal(download.status, 200)
    assert.equal(download.headers.get('x-content-sha256'), sha)
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes)
  } finally {
    holderClient.close()
  }
})

test('relay skips a holder that cannot serve the file', async () => {
  const topic = (await createTopics(stack.adminBase, ['relay retry']))[0]
  const author = { installationId: 'retry-author', sessionId: 'a' }
  const peer = { installationId: 'retry-peer', sessionId: 'b' }
  for (const ids of [author, peer]) {
    await register(stack.base, ids.installationId, ids.sessionId)
    await subscribe(stack.base, ids, topic.id)
  }
  const bytes = Buffer.from('package-bytes')
  const sha = createHash('sha256').update(bytes).digest('hex')
  const shared = await request(`${stack.base}/v1/messages/file`, {
    ...author,
    topicId: topic.id,
    kind: 'post',
    requestId: crypto.randomUUID(),
    intro: 'pkg',
    fileSha256: sha,
    fileSize: bytes.length,
  })
  const messageId = shared.body.id
  // The most recently registered holder is tried first.
  const goodIds = { installationId: 'retry-good', sessionId: 'g' }
  const badIds = { installationId: 'retry-bad', sessionId: 'b' }
  for (const ids of [goodIds, badIds]) {
    await register(stack.base, ids.installationId, ids.sessionId)
    await subscribe(stack.base, ids, topic.id)
  }
  const good = fakeHolder({ base: stack.base, installationId: 'retry-good', files: new Map([[`${topic.id}/${messageId}`, bytes]]) })
  const bad = fakeHolder({ base: stack.base, installationId: 'retry-bad', files: new Map() })
  await good.ready
  await bad.ready
  await request(`${stack.base}/v1/holders`, { ...goodIds, topicId: topic.id, messageId })
  await request(`${stack.base}/v1/holders`, { ...badIds, topicId: topic.id, messageId })
  try {
    const download = await fetch(`${stack.base}/v1/files/${topic.id}/${messageId}?installationId=retry-peer&sessionId=b`)
    assert.equal(download.status, 200)
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes)
  } finally {
    good.close()
    bad.close()
  }
})

test('file declarations validate sha and size', async () => {
  const topic = (await createTopics(stack.adminBase, ['relay validation']))[0]
  const a = { installationId: 'validate-host', sessionId: 'a' }
  await register(stack.base, a.installationId, a.sessionId)
  await subscribe(stack.base, a, topic.id)
  const badSha = await request(`${stack.base}/v1/messages/file`, {
    ...a, topicId: topic.id, kind: 'post', requestId: crypto.randomUUID(),
    intro: 'x', fileSha256: 'not-a-hash', fileSize: 10,
  })
  assert.equal(badSha.status, 400)
  const huge = await request(`${stack.base}/v1/messages/file`, {
    ...a, topicId: topic.id, kind: 'post', requestId: crypto.randomUUID(),
    intro: 'x', fileSha256: 'a'.repeat(64), fileSize: 1024 * 1024 + 1,
  })
  assert.equal(huge.status, 413)
  assert.equal(huge.body.error.code, 'FILE_TOO_LARGE')
})

test('a file message is rejected when the author host denies holding the blob', async () => {
  const topic = (await createTopics(stack.adminBase, ['file probe']))[0]
  const a = { installationId: 'probe-host', sessionId: 'a' }
  await register(stack.base, a.installationId, a.sessionId)
  await subscribe(stack.base, a, topic.id)
  const bytes = Buffer.from('probe payload')
  const sha = createHash('sha256').update(bytes).digest('hex')
  const gateway = fakeHolder({
    base: stack.base,
    installationId: a.installationId,
    files: new Map([['seed', bytes]]),
  })
  await gateway.ready
  try {
    const accepted = await request(`${stack.base}/v1/messages/file`, {
      ...a, topicId: topic.id, kind: 'post', requestId: crypto.randomUUID(),
      intro: 'held', fileSha256: sha, fileSize: bytes.length,
    })
    assert.equal(accepted.status, 200)

    const rejected = await request(`${stack.base}/v1/messages/file`, {
      ...a, topicId: topic.id, kind: 'post', requestId: crypto.randomUUID(),
      intro: 'missing', fileSha256: 'b'.repeat(64), fileSize: bytes.length,
    })
    assert.equal(rejected.status, 409)
    assert.equal(rejected.body.error.code, 'FILE_NOT_HELD')
    assert.equal(stack.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE topic_id = ?').get(topic.id).c, 1)
  } finally {
    gateway.close()
  }
})

test('a file reply never disappears behind an existing comment', async () => {
  const topic = (await createTopics(stack.adminBase, ['file reply conflict']))[0]
  const a = { installationId: 'file-reply-host', sessionId: 'a' }
  await register(stack.base, a.installationId, a.sessionId)
  await subscribe(stack.base, a, topic.id)

  const root = await post(stack.base, a, topic.id, 'root')
  const textReply = await post(stack.base, a, topic.id, 'text reply', { parentId: root.body.id })
  assert.equal(textReply.status, 200)

  const fileReply = (sha, size, intro, parentId) => request(`${stack.base}/v1/messages/file`, {
    ...a, topicId: topic.id, kind: 'comment', parentId,
    requestId: crypto.randomUUID(), intro, fileSha256: sha, fileSize: size,
  })

  const sha = createHash('sha256').update('conflict bytes').digest('hex')
  const conflict = await fileReply(sha, 14, 'file reply', root.body.id)
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'COMMENT_EXISTS')
  assert.equal(conflict.body.error.details.existingId, textReply.body.id)

  // The rejected share did not create a message.
  const history = await fetch(`${stack.base}/v1/history/${topic.id}?installationId=${a.installationId}&sessionId=${a.sessionId}`)
  assert.equal((await history.text()).trim().split('\n').length, 2)

  // A first file reply on an unanswered message works, and re-announcing the
  // same file is an idempotent success instead of a second comment.
  const otherRoot = await post(stack.base, a, topic.id, 'second root')
  const first = await fileReply(sha, 14, 'first file reply', otherRoot.body.id)
  assert.equal(first.status, 200)
  assert.equal(first.body.duplicate, false)
  const again = await fileReply(sha, 14, 'first file reply again', otherRoot.body.id)
  assert.equal(again.status, 200)
  assert.equal(again.body.duplicate, true)
  assert.equal(again.body.id, first.body.id)

  // A different file after a file reply is a new conflict.
  const otherSha = createHash('sha256').update('other bytes').digest('hex')
  const different = await fileReply(otherSha, 11, 'different file', otherRoot.body.id)
  assert.equal(different.status, 409)
  assert.equal(different.body.error.code, 'COMMENT_EXISTS')
  assert.equal(different.body.error.details.existingId, first.body.id)
})

test('mailbox routing: author excluded, parent author flagged', async () => {
  const a = { installationId: 'h8', sessionId: 'a' }
  const b = { installationId: 'h8', sessionId: 'b' }
  const c = { installationId: 'h8', sessionId: 'c' }
  for (const ids of [a, b, c]) {
    await register(stack.base, ids.installationId, ids.sessionId)
    await subscribe(stack.base, ids, topicId)
  }
  const postResult = await post(stack.base, a, topicId, 'routing root')
  assert.deepEqual(pendingMail(stack.db, a), [])
  const toB = pendingMail(stack.db, b)
  const toC = pendingMail(stack.db, c)
  assert.equal(toB.length, 1)
  assert.equal(toC.length, 1)
  assert.equal(toB[0].payload.toYou, false)
  assert.equal(toB[0].payload.messageId, postResult.body.id)
  assert.equal(toB[0].payload.author, (await register(stack.base, a.installationId, a.sessionId)).body.username)

  // New mail is appended after the earlier rows; ack first to isolate the comment.
  for (const ids of [a, b, c]) {
    const rows = pendingMail(stack.db, ids)
    if (rows.length > 0) await request(`${stack.base}/v1/ack`, { ...ids, mailIds: rows.map(row => row.seq) })
  }

  await post(stack.base, b, topicId, 'reply to a', { parentId: postResult.body.id })
  const commentToA = pendingMail(stack.db, a)
  const commentToC = pendingMail(stack.db, c)
  assert.equal(commentToA[0].payload.toYou, true)
  assert.equal(commentToC[0].payload.toYou, false)
  assert.equal(commentToA[0].payload.kind, 'comment')
  assert.equal(commentToA[0].payload.parentId, postResult.body.id)
})

test('mentions mark the target and are validated before delivery', async () => {
  const topic = (await createTopics(stack.adminBase, ['mention tests']))[0]
  const a = { installationId: 'mention-host', sessionId: 'a' }
  const b = { installationId: 'mention-host', sessionId: 'b' }
  const c = { installationId: 'mention-host', sessionId: 'c' }
  const outsider = { installationId: 'mention-other', sessionId: 'o' }
  for (const ids of [a, b, c, outsider]) await register(stack.base, ids.installationId, ids.sessionId)
  for (const ids of [a, b, c]) await subscribe(stack.base, ids, topic.id)
  const names = {}
  for (const [key, ids] of Object.entries({ a, b, c, outsider })) {
    names[key] = (await register(stack.base, ids.installationId, ids.sessionId)).body.username
  }

  const mentioned = await request(`${stack.base}/v1/messages`, {
    ...a, topicId: topic.id, kind: 'post', requestId: crypto.randomUUID(),
    text: 'need a review', at: names.b,
  })
  assert.equal(mentioned.status, 200)
  const toB = pendingMail(stack.db, b).find(row => row.payload.messageId === mentioned.body.id)
  assert.equal(toB.payload.at, names.b)
  assert.equal(toB.payload.mentionYou, true)
  assert.equal(toB.payload.toYou, false)
  const toC = pendingMail(stack.db, c).find(row => row.payload.messageId === mentioned.body.id)
  assert.equal(toC.payload.mentionYou, false)

  // The exported history carries the mention.
  const history = await fetch(`${stack.base}/v1/history/${topic.id}?installationId=${a.installationId}&sessionId=${a.sessionId}`)
  const exported = (await history.text()).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(exported.find(line => line.id === mentioned.body.id).at, names.b)

  // A reply can be both a direct reply and a mention of someone else.
  const reply = await request(`${stack.base}/v1/messages`, {
    ...b, topicId: topic.id, kind: 'comment', parentId: mentioned.body.id,
    requestId: crypto.randomUUID(), text: 'on it', at: names.c,
  })
  assert.equal(reply.status, 200)
  const toA = pendingMail(stack.db, a).find(row => row.payload.messageId === reply.body.id)
  assert.equal(toA.payload.toYou, true)
  assert.equal(toA.payload.mentionYou, false)
  const toC2 = pendingMail(stack.db, c).find(row => row.payload.messageId === reply.body.id)
  assert.equal(toC2.payload.mentionYou, true)

  // Self, unknown and unsubscribed mentions are rejected without a message.
  const self = await request(`${stack.base}/v1/messages`, {
    ...a, topicId: topic.id, kind: 'post', requestId: crypto.randomUUID(), text: 'self', at: `@${names.a}`,
  })
  assert.equal(self.status, 400)
  assert.equal(self.body.error.code, 'MENTION_SELF')
  const unknown = await request(`${stack.base}/v1/messages`, {
    ...a, topicId: topic.id, kind: 'post', requestId: crypto.randomUUID(), text: 'unknown', at: 'no-such-user',
  })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error.code, 'USER_NOT_FOUND')
  const unsubscribed = await request(`${stack.base}/v1/messages`, {
    ...a, topicId: topic.id, kind: 'post', requestId: crypto.randomUUID(), text: 'outsider', at: names.outsider,
  })
  assert.equal(unsubscribed.status, 409)
  assert.equal(unsubscribed.body.error.code, 'MENTION_NOT_SUBSCRIBED')
  assert.equal(stack.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE topic_id = ?').get(topic.id).c, 2)

  // File messages mention too.
  const shared = await request(`${stack.base}/v1/messages/file`, {
    ...a, topicId: topic.id, kind: 'post', requestId: crypto.randomUUID(),
    intro: 'log', fileSha256: 'a'.repeat(64), fileSize: 12, at: names.b,
  })
  assert.equal(shared.status, 200)
  const fileMail = pendingMail(stack.db, b).find(row => row.payload.messageId === shared.body.id)
  assert.equal(fileMail.payload.at, names.b)
  assert.equal(fileMail.payload.mentionYou, true)
})

test('SSE delivery, ack and reconnect resend', async () => {
  const a = { installationId: 'h9', sessionId: 'a' }
  const b = { installationId: 'h9', sessionId: 'b' }
  for (const ids of [a, b]) {
    await register(stack.base, ids.installationId, ids.sessionId)
    await subscribe(stack.base, ids, topicId)
  }
  const stream = openStream(`${stack.base}/v1/gateway?installationId=h9&sessionId=b`)
  const welcome = await stream.next(event => event.type === 'welcome')
  assert.ok(welcome.retryAfterSeconds >= 1)
  assert.equal('retryAfterMs' in welcome, false)

  const message = await post(stack.base, a, topicId, 'live delivery')
  const delivery = await stream.next(event => event.type === 'delivery')
  assert.equal(delivery.messages[0].messageId, message.body.id)
  assert.equal(delivery.messages[0].text, 'live delivery')

  const acked = await request(`${stack.base}/v1/ack`, { ...b, mailIds: [delivery.messages[0].mailId] })
  assert.equal(acked.status, 200)
  assert.deepEqual(pendingMail(stack.db, b), [])
  stream.close()

  const reopened = openStream(`${stack.base}/v1/gateway?installationId=h9&sessionId=b`)
  await reopened.next(event => event.type === 'welcome')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(reopened.events.filter(event => event.type === 'delivery').length, 0)
  reopened.close()

  // Without an ack the same mail is re-sent on reconnect.
  const message2 = await post(stack.base, a, topicId, 'unacked')
  const stream3 = openStream(`${stack.base}/v1/gateway?installationId=h9&sessionId=b`)
  const redelivery = await stream3.next(event => event.type === 'delivery')
  assert.equal(redelivery.messages[0].messageId, message2.body.id)
  stream3.close()
})

test('unsubscribe drops queued mail for that topic', async () => {
  const a = { installationId: 'h10', sessionId: 'a' }
  const b = { installationId: 'h10', sessionId: 'b' }
  for (const ids of [a, b]) {
    await register(stack.base, ids.installationId, ids.sessionId)
    await subscribe(stack.base, ids, topicId)
  }
  await post(stack.base, a, topicId, 'queued')
  assert.equal(pendingMail(stack.db, b).length > 0, true)
  await subscribe(stack.base, b, topicId, false)
  assert.deepEqual(pendingMail(stack.db, b), [])
  const denied = await post(stack.base, b, topicId, 'after unsubscribe')
  assert.equal(denied.body.error.code, 'NOT_SUBSCRIBED')
})

test('dashboard is a read-only topic chat view', async () => {
  const page = await fetch(`${stack.base}/`)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /Read-only board/)
  assert.match(html, /id="topic-list"/)
  assert.match(html, /@keyframes row-flash/)
  assert.match(html, /function flashMessage/)
  assert.match(html, /function animateScroll/)
  assert.doesNotMatch(html, /Sessions/)
  assert.doesNotMatch(html, /last seen/i)
  const api = await fetch(`${stack.base}/dashboard/api`)
  assert.equal(api.status, 200)
  const data = await api.json()
  assert.ok(data.topics.length > 0)
  assert.ok(data.selected !== null)
  assert.ok(Array.isArray(data.messages))
  assert.equal('sessions' in data, false)
  assert.equal('active' in data.selected, false)
  assert.equal('lastSeenAt' in data.selected, false)
})

test('dashboard returns one topic chat and reports truncation', async () => {
  const topic = (await createTopics(stack.adminBase, ['dashboard chat']))[0]
  const a = { installationId: 'dashboard-host', sessionId: 'a' }
  await register(stack.base, a.installationId, a.sessionId)
  await subscribe(stack.base, a, topic.id)
  const first = await post(stack.base, a, topic.id, 'hello dashboard')
  const second = await post(stack.base, a, topic.id, 'second line')

  const api = await fetch(`${stack.base}/dashboard/api?topic=${topic.id}`)
  assert.equal(api.status, 200)
  const data = await api.json()
  assert.equal(data.selected.id, topic.id)
  assert.deepEqual(data.messages.map(message => message.id), [first.body.id, second.body.id])
  assert.equal(data.messages[0].text, 'hello dashboard')
  assert.equal(data.messages[0].kind, 'post')
  assert.equal(typeof data.messages[0].createdAt, 'number')
  assert.equal(data.truncated, false)

  const unknown = await fetch(`${stack.base}/dashboard/api?topic=zzzzzz`)
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.json()).error.code, 'TOPIC_NOT_FOUND')

  const trimmed = dashboardData(stack.db, { topicId: topic.id, limit: 1 })
  assert.equal(trimmed.messages.length, 1)
  assert.equal(trimmed.messages[0].id, second.body.id)
  assert.equal(trimmed.truncated, true)
})

test('query exports the whole tree, including ancestors and sibling branches', async () => {
  const topic = (await createTopics(stack.adminBase, ['tree semantics']))[0]
  const a = { installationId: 'tree', sessionId: 'a' }
  const b = { installationId: 'tree', sessionId: 'b' }
  const c = { installationId: 'tree', sessionId: 'c' }
  for (const ids of [a, b, c]) {
    await register(stack.base, ids.installationId, ids.sessionId)
    await subscribe(stack.base, ids, topic.id)
  }
  const root = await post(stack.base, a, topic.id, 'root')
  const left = await post(stack.base, b, topic.id, 'left', { parentId: root.body.id })
  const right = await post(stack.base, c, topic.id, 'right', { parentId: root.body.id })
  const deep = await post(stack.base, a, topic.id, 'deep', { parentId: left.body.id })

  const exported = await fetch(
    `${stack.base}/v1/query/${topic.id}/${deep.body.id}?installationId=tree&sessionId=a`,
  )
  const rows = (await exported.text()).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(
    rows.map(row => row.id),
    [root.body.id, left.body.id, right.body.id, deep.body.id],
    'the deep comment sees its root, its parent, its parent\'s sibling and itself',
  )
  assert.equal(new Set(rows.map(row => row.id)).size, 4)
})

test('relay concurrency is bounded and the excess is retryable', async () => {
  const parallel = await startStack({ relayMaxConcurrent: 2, ratePerMinute: 100 })
  try {
    const topic = (await createTopics(parallel.adminBase, ['relay concurrency']))[0]
    const holder = { installationId: 'conc-holder', sessionId: 'h' }
    const peer = { installationId: 'conc-peer', sessionId: 'p' }
    for (const ids of [holder, peer]) {
      await register(parallel.base, ids.installationId, ids.sessionId)
      await subscribe(parallel.base, ids, topic.id)
    }
    const bytes = Buffer.from('concurrent payload')
    const sha = createHash('sha256').update(bytes).digest('hex')
    const shared = await request(`${parallel.base}/v1/messages/file`, {
      ...holder,
      topicId: topic.id,
      kind: 'post',
      requestId: crypto.randomUUID(),
      intro: 'pkg',
      fileSha256: sha,
      fileSize: bytes.length,
    })
    const messageId = shared.body.id
    const holderClient = fakeHolder({
      base: parallel.base,
      installationId: 'conc-holder',
      files: new Map([[`${topic.id}/${messageId}`, bytes]]),
      delayMs: 150,
    })
    await holderClient.ready
    try {
      const responses = await Promise.all(Array.from({ length: 6 }, () =>
        fetch(`${parallel.base}/v1/files/${topic.id}/${messageId}?installationId=conc-peer&sessionId=p`)))
      const ok = responses.filter(response => response.status === 200)
      const rejected = responses.filter(response => response.status !== 200)
      assert.equal(ok.length, 2, 'the concurrency cap admits exactly two')
      assert.equal(rejected.length, 4)
      for (const response of ok) {
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
      }
      for (const response of rejected) {
        assert.equal(response.status, 503)
        assert.equal((await response.json()).error.code, 'TRANSFER_FAILED')
      }
    } finally {
      holderClient.close()
    }
  } finally {
    await parallel.close()
  }
})

test('holders can be withdrawn and a text message has no attachment', async () => {
  const topic = (await createTopics(stack.adminBase, ['holder removal']))[0]
  const author = { installationId: 'remove-author', sessionId: 'a' }
  const peer = { installationId: 'remove-peer', sessionId: 'b' }
  for (const ids of [author, peer]) {
    await register(stack.base, ids.installationId, ids.sessionId)
    await subscribe(stack.base, ids, topic.id)
  }
  const text = await post(stack.base, author, topic.id, 'plain text')
  const noFile = await fetch(`${stack.base}/v1/files/${topic.id}/${text.body.id}?installationId=remove-peer&sessionId=b`)
  assert.equal(noFile.status, 404)
  assert.equal((await noFile.json()).error.code, 'NO_ATTACHMENT')
  const badHolder = await request(`${stack.base}/v1/holders`, { ...peer, topicId: topic.id, messageId: text.body.id })
  assert.equal(badHolder.status, 404)
  assert.equal(badHolder.body.error.code, 'NO_ATTACHMENT')

  const bytes = Buffer.from('withdrawable')
  const sha = createHash('sha256').update(bytes).digest('hex')
  const shared = await request(`${stack.base}/v1/messages/file`, {
    ...author, topicId: topic.id, kind: 'post', requestId: crypto.randomUUID(),
    intro: 'pkg', fileSha256: sha, fileSize: bytes.length,
  })
  const messageId = shared.body.id
  assert.ok(listHolders(stack.db, topic.id, messageId).includes('remove-author'))
  const withdrawn = await request(`${stack.base}/v1/holders/remove`, {
    ...author, topicId: topic.id, messageId,
  })
  assert.equal(withdrawn.status, 200)
  assert.deepEqual(listHolders(stack.db, topic.id, messageId), [])
  const unavailable = await fetch(`${stack.base}/v1/files/${topic.id}/${messageId}?installationId=remove-peer&sessionId=b`)
  assert.equal(unavailable.status, 503)
  assert.equal((await unavailable.json()).error.code, 'FILE_UNAVAILABLE')
})

test('holder registration requires a subscription', async () => {
  const topic = (await createTopics(stack.adminBase, ['holder auth']))[0]
  const author = { installationId: 'auth-author', sessionId: 'a' }
  const outsider = { installationId: 'auth-outsider', sessionId: 'o' }
  await register(stack.base, author.installationId, author.sessionId)
  await subscribe(stack.base, author, topic.id)
  await register(stack.base, outsider.installationId, outsider.sessionId)
  const bytes = Buffer.from('x')
  const sha = createHash('sha256').update(bytes).digest('hex')
  const shared = await request(`${stack.base}/v1/messages/file`, {
    ...author, topicId: topic.id, kind: 'post', requestId: crypto.randomUUID(),
    intro: 'pkg', fileSha256: sha, fileSize: bytes.length,
  })
  const denied = await request(`${stack.base}/v1/holders`, {
    ...outsider, topicId: topic.id, messageId: shared.body.id,
  })
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error.code, 'NOT_SUBSCRIBED')
})

test('a silent holder is cancelled after the start timeout', async () => {
  const silent = await startStack({ relayStartTimeoutMs: 100, ratePerMinute: 100 })
  try {
    const topic = (await createTopics(silent.adminBase, ['silent holder']))[0]
    const author = { installationId: 'silent-author', sessionId: 'a' }
    const peer = { installationId: 'silent-peer', sessionId: 'b' }
    for (const ids of [author, peer]) {
      await register(silent.base, ids.installationId, ids.sessionId)
      await subscribe(silent.base, ids, topic.id)
    }
    const bytes = Buffer.from('never sent')
    const sha = createHash('sha256').update(bytes).digest('hex')
    const shared = await request(`${silent.base}/v1/messages/file`, {
      ...author, topicId: topic.id, kind: 'post', requestId: crypto.randomUUID(),
      intro: 'pkg', fileSha256: sha, fileSize: bytes.length,
    })
    const stream = openStream(`${silent.base}/v1/host-gateway?installationId=silent-author`)
    await stream.next(event => event.type === 'welcome')
    const download = await fetch(
      `${silent.base}/v1/files/${topic.id}/${shared.body.id}?installationId=silent-peer&sessionId=b`,
    )
    assert.equal(download.status, 503)
    assert.equal((await download.json()).error.code, 'FILE_UNAVAILABLE')
    const cancel = await stream.next(event => event.type === 'cancel')
    assert.equal(typeof cancel.transferId, 'string')
    stream.close()
  } finally {
    await silent.close()
  }
})

test('a post cannot carry a parent id', async () => {
  const stack = await startStack({ ratePerMinute: 100 })
  const [topic] = await createTopics(stack.adminBase, ['post parent guard'])
  const a = { installationId: 'pp-host', sessionId: 'pp' }
  await register(stack.base, a.installationId, a.sessionId)
  await subscribe(stack.base, a, topic.id)
  try {
    const root = await post(stack.base, a, topic.id, 'root')
    assert.equal(root.status, 200)
    const withParent = await request(`${stack.base}/v1/messages`, {
      ...a, topicId: topic.id, kind: 'post', parentId: root.body.id,
      requestId: crypto.randomUUID(), text: 'post with parent',
    })
    assert.equal(withParent.status, 400)
    assert.equal(withParent.body.error.code, 'PARENT_NOT_ALLOWED')
    // The rejected write leaves nothing behind: the comment still lands.
    const comment = await request(`${stack.base}/v1/messages`, {
      ...a, topicId: topic.id, kind: 'comment', parentId: root.body.id,
      requestId: crypto.randomUUID(), text: 'real comment',
    })
    assert.equal(comment.status, 200)
    assert.equal(comment.body.duplicate, false)
    const reply = await post(stack.base, a, topic.id, 'second comment attempt', { parentId: root.body.id })
    assert.equal(reply.body.duplicate, true, 'one comment per session per parent')
  } finally {
    await stack.close()
  }
})
