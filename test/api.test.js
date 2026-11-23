import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DiscussApi } from '../client/src/api.js'
import { createTopics, fakeHolder, register, request, startStack, subscribe } from './helpers.js'

async function setup(bytes, declaredSha) {
  const stack = await startStack({ ratePerMinute: 100 })
  const topic = (await createTopics(stack.adminBase, [`api ${Math.random()}`]))[0]
  const holder = { installationId: `api-holder-${Math.random()}`, sessionId: 'h' }
  const peer = { installationId: `api-peer-${Math.random()}`, sessionId: 'p' }
  for (const ids of [holder, peer]) {
    await register(stack.base, ids.installationId, ids.sessionId)
    await subscribe(stack.base, ids, topic.id)
  }
  const shared = await request(`${stack.base}/v1/messages/file`, {
    ...holder,
    topicId: topic.id,
    kind: 'post',
    requestId: crypto.randomUUID(),
    intro: 'pkg',
    fileSha256: declaredSha,
    fileSize: bytes.length,
  })
  assert.equal(shared.status, 200)
  const holderClient = fakeHolder({
    base: stack.base,
    installationId: holder.installationId,
    files: new Map([[`${topic.id}/${shared.body.id}`, bytes]]),
  })
  await holderClient.ready
  const api = new DiscussApi({ baseUrl: stack.base, timeoutMs: 5000 })
  return {
    stack,
    topic,
    messageId: shared.body.id,
    peer,
    api,
    holderClient,
    async close() {
      holderClient.close()
      await stack.close()
    },
  }
}

test('requestFile streams to disk and verifies the sha256', async () => {
  const bytes = Buffer.from('verified payload')
  const sha = createHash('sha256').update(bytes).digest('hex')
  const context = await setup(bytes, sha)
  const temporary = join(context.stack.dir, 'download.bin')
  try {
    const result = await context.api.requestFile(context.peer, context.topic.id, context.messageId, temporary)
    assert.equal(result.sha256, sha)
    assert.equal(result.size, bytes.length)
    assert.deepEqual(readFileSync(temporary), bytes)
  } finally {
    await context.close()
  }
})

test('requestFile rejects a hash mismatch and removes the temporary file', async () => {
  const declared = Buffer.from('aaaaaaaaaa')
  const served = Buffer.from('bbbbbbbbbb')
  const sha = createHash('sha256').update(declared).digest('hex')
  const context = await setup(served, sha)
  const temporary = join(context.stack.dir, 'bad.bin')
  try {
    await assert.rejects(
      () => context.api.requestFile(context.peer, context.topic.id, context.messageId, temporary),
      error => error.code === 'HASH_MISMATCH',
    )
    assert.equal(existsSync(temporary), false, 'the partial download is discarded')
  } finally {
    await context.close()
  }
})

test('requestFile reports FILE_UNAVAILABLE when no holder is online', async () => {
  const bytes = Buffer.from('nobody home')
  const sha = createHash('sha256').update(bytes).digest('hex')
  const context = await setup(bytes, sha)
  const temporary = join(context.stack.dir, 'missing.bin')
  try {
    // Drop only the holder connection; the holder row and the board stay.
    context.holderClient.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    await assert.rejects(
      () => context.api.requestFile(context.peer, context.topic.id, context.messageId, temporary),
      error => error.code === 'FILE_UNAVAILABLE',
    )
  } finally {
    await context.close()
  }
})
