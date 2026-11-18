import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createTopics, request, startStack } from './helpers.js'

/** @type {Awaited<ReturnType<typeof startStack>>} */
let stack

before(async () => {
  stack = await startStack()
})

after(async () => {
  await stack.close()
})

test('only one create token may be outstanding', async () => {
  const first = await request(`${stack.adminBase}/v1/admin/topics/request`, {})
  assert.equal(first.status, 200)
  assert.equal(typeof first.body.token, 'string')
  assert.ok(first.body.expiresAt > Date.now())

  const second = await request(`${stack.adminBase}/v1/admin/topics/request`, {})
  assert.equal(second.status, 409)
  assert.equal(second.body.error.code, 'TOKEN_HELD')
  assert.equal(second.body.error.retryable, true)
  assert.ok(second.body.error.retryAfterSeconds >= 1)
  assert.equal('retryAfterMs' in second.body.error, false)

  const raw = await fetch(`${stack.adminBase}/v1/admin/topics/request`, { method: 'POST' })
  assert.equal(raw.status, 409)
  const rawBody = await raw.json()
  assert.equal(rawBody.error.code, 'TOKEN_HELD')
  assert.equal(raw.headers.get('retry-after'), String(rawBody.error.retryAfterSeconds))

  // Leave no live token for the following tests.
  const cleared = await request(`${stack.adminBase}/v1/admin/topics/confirm`, {
    token: first.body.token,
    names: ['token slot seed'],
  })
  assert.equal(cleared.status, 200)
})

test('confirm always invalidates the token', async () => {
  const issued = await request(`${stack.adminBase}/v1/admin/topics/request`, {})
  const confirmed = await request(`${stack.adminBase}/v1/admin/topics/confirm`, {
    token: issued.body.token,
    names: ['confirm topic'],
  })
  assert.equal(confirmed.status, 200)
  assert.deepEqual(confirmed.body.results.map(row => row.status), ['created'])

  const replay = await request(`${stack.adminBase}/v1/admin/topics/confirm`, {
    token: issued.body.token,
    names: ['replay'],
  })
  assert.equal(replay.status, 400)
  assert.equal(replay.body.error.code, 'TOKEN_EXPIRED')

  const fresh = await request(`${stack.adminBase}/v1/admin/topics/request`, {})
  assert.equal(fresh.status, 200, 'the slot is free again')
})

test('a stale token is rejected', async () => {
  const short = await startStack({ adminTokenTtlMs: 40 })
  try {
    const issued = await request(`${short.adminBase}/v1/admin/topics/request`, {})
    await new Promise(resolve => setTimeout(resolve, 80))
    const confirmed = await request(`${short.adminBase}/v1/admin/topics/confirm`, {
      token: issued.body.token,
      names: ['too late'],
    })
    assert.equal(confirmed.status, 400)
    assert.equal(confirmed.body.error.code, 'TOKEN_EXPIRED')
    const reopened = await request(`${short.adminBase}/v1/admin/topics/request`, {})
    assert.equal(reopened.status, 200, 'an expired token frees the slot')
  } finally {
    await short.close()
  }
})

test('an invalid name rejects the whole batch', async () => {
  const issued = await request(`${stack.adminBase}/v1/admin/topics/request`, {})
  const confirmed = await request(`${stack.adminBase}/v1/admin/topics/confirm`, {
    token: issued.body.token,
    names: ['valid name', '   '],
  })
  assert.equal(confirmed.status, 400)
  const all = await request(`${stack.adminBase}/v1/admin/topics`, {}, 'GET')
  assert.equal(all.body.topics.some(topic => topic.name === 'valid name'), false)
})

test('concurrent create requests admit exactly one', async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () => request(`${stack.adminBase}/v1/admin/topics/request`, {})),
  )
  assert.equal(results.filter(result => result.status === 200).length, 1)
  assert.equal(results.filter(result => result.status === 409).length, 19)
  const winner = results.find(result => result.status === 200)
  const confirmed = await request(`${stack.adminBase}/v1/admin/topics/confirm`, {
    token: winner.body.token,
    names: ['race winner'],
  })
  assert.equal(confirmed.status, 200)
})

test('concurrent confirms with one token admit exactly one', async () => {
  const issued = await request(`${stack.adminBase}/v1/admin/topics/request`, {})
  const results = await Promise.all(
    Array.from({ length: 20 }, (_unused, index) => request(`${stack.adminBase}/v1/admin/topics/confirm`, {
      token: issued.body.token,
      names: [`race confirm ${index}`],
    })),
  )
  assert.equal(results.filter(result => result.status === 200).length, 1)
  assert.equal(results.filter(result => result.body?.error?.code === 'TOKEN_EXPIRED').length, 19)
  const all = await request(`${stack.adminBase}/v1/admin/topics`, {}, 'GET')
  const created = all.body.topics.filter(topic => topic.name.startsWith('race confirm '))
  assert.equal(created.length, 1, 'only the winning batch created rows')
})

test('admin and discuss share one database across two connections', async () => {
  await createTopics(stack.adminBase, ['shared database'])
  const topics = await request(`${stack.base}/v1/topics?installationId=x&sessionId=y`, undefined, 'GET')
  assert.equal(topics.status, 200)
  assert.ok(topics.body.all.some(topic => topic.name === 'shared database'))
})
