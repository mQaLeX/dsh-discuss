import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SessionClient } from '../client/src/core.js'

class FakeApi {
  constructor() {
    this.acked = []
    this.ackCalls = 0
    this.failAcks = 0
    this.topicsResult = { subscribed: [], all: [] }
    this.username = 'test-user'
    this.onFrame = undefined
    this.registers = 0
    this.unregisters = 0
  }

  async register() {
    this.registers += 1
    return { username: this.username, limits: { contentMax: 100, ratePerMinute: 5, fileMaxBytes: 1000 } }
  }

  async unregister() {
    this.unregisters += 1
  }

  async ack(_ids, mailIds) {
    this.ackCalls += 1
    if (this.failAcks > 0) {
      this.failAcks -= 1
      throw new Error('ack endpoint down')
    }
    this.acked.push(...mailIds)
  }

  async stream(_ids, options) {
    this.onFrame = options.onFrame
    await new Promise((resolve) => {
      options.signal.addEventListener('abort', resolve, { once: true })
    })
  }

  async topics() {
    return this.topicsResult
  }

  async setSubscription() {}

  async write() {
    return { id: 1 }
  }

  async writeFile() {
    return { id: 2 }
  }
}

class FakeAgent {
  constructor() {
    this.status = 'idle'
    this.messages = []
    /** Digests delivered as a follow-up turn (they woke the driver). */
    this.woken = []
    this.inbox = {
      remove: (id) => {
        const index = this.messages.findIndex(message => message.id === id)
        if (index === -1) return false
        this.messages.splice(index, 1)
        return true
      },
    }
  }

  inject(message) {
    this.messages.push(message)
  }

  followup(message) {
    this.messages.push(message)
    this.woken.push(message)
  }
}

function makeClient(overrides = {}) {
  let time = 0
  let counter = 0
  const agent = new FakeAgent()
  const api = new FakeApi()
  const spooled = []
  const spool = {
    append: (messages) => { spooled.push(...messages) },
    replace: (messages) => { spooled.length = 0; spooled.push(...messages) },
    load: () => [],
    clear: () => { spooled.length = 0 },
  }
  const client = new SessionClient({
    ids: { installationId: 'host', sessionId: 'session' },
    agent,
    api,
    spool,
    makeMessage: (text, count) => ({ id: `digest-${++counter}`, text, count }),
    config: { coalesceMs: 15_000, mergeThrottleMs: 30_000, digestMaxMessages: 20, digestMaxChars: 8000 },
    now: () => time,
    ...overrides,
  })
  return {
    client,
    agent,
    api,
    spooled,
    advance: (ms) => { time += ms },
  }
}

function mail(mailId, extra = {}) {
  return {
    mailId,
    topicId: 'ab12cd',
    messageId: mailId,
    kind: 'post',
    author: 'peer',
    text: `message ${mailId}`,
    fileSize: null,
    parentId: null,
    toYou: false,
    ...extra,
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 260))

test('delivery is deduped by mail id and acked once', async () => {
  const { client, api } = makeClient()
  client.deliver([mail(1), mail(1)])
  assert.equal(client.pending.length, 1)
  await settle()
  assert.deepEqual(api.acked, [1])
  await client.close()
})

test('idle messages coalesce before the first inject', async () => {
  const { client, agent, advance } = makeClient()
  client.deliver([mail(1), mail(2)])
  client.tick()
  assert.equal(agent.messages.length, 0, 'nothing is injected during the coalescing window')
  advance(15_000)
  client.tick()
  assert.equal(agent.messages.length, 1)
  assert.match(agent.messages[0].text, /2 new messages/)
  assert.match(agent.messages[0].text, /message 1/)
  assert.match(agent.messages[0].text, /message 2/)
  assert.equal(client.pending.length, 0)
  await client.close()
})

test('nothing is injected while the agent is running', async () => {
  const { client, agent, advance } = makeClient()
  agent.status = 'running'
  client.deliver([mail(1)])
  advance(60_000)
  client.tick()
  assert.equal(agent.messages.length, 0)
  agent.status = 'idle'
  client.onStatus('idle')
  assert.equal(agent.messages.length, 1, 'an idle transition flushes immediately')
  await client.close()
})

test('later arrivals merge into the pending digest', async () => {
  const { client, agent, advance } = makeClient()
  client.deliver([mail(1)])
  advance(15_000)
  client.tick()
  assert.equal(agent.messages.length, 1)
  const firstId = agent.messages[0].id

  client.deliver([mail(2), mail(3)])
  client.tick()
  assert.equal(agent.messages.length, 1, 'the rewrite waits for the throttle')
  advance(30_000)
  client.tick()
  assert.equal(agent.messages.length, 1, 'the old digest is removed, not duplicated')
  assert.notEqual(agent.messages[0].id, firstId)
  assert.match(agent.messages[0].text, /3 new messages/)
  assert.match(agent.messages[0].text, /message 3/)
  await client.close()
})

test('a claim clears the backlog', async () => {
  const { client, agent, advance } = makeClient()
  client.deliver([mail(1), mail(2)])
  advance(15_000)
  client.tick()
  assert.equal(agent.messages.length, 1)
  assert.deepEqual(client.backlog(), { ab12cd: { injected: 2, pending: 0 } })
  client.onClaimed(agent.messages[0].id)
  assert.deepEqual(client.backlog(), {})
  await client.close()
})

test('a claimed digest is not rewritten over', async () => {
  const { client, agent, advance } = makeClient()
  client.deliver([mail(1)])
  advance(15_000)
  client.tick()
  const digest = agent.messages[0]
  agent.messages.length = 0 // simulate the model claiming it
  client.onClaimed(digest.id)
  client.deliver([mail(2)])
  advance(60_000)
  client.tick()
  assert.equal(agent.messages.length, 1)
  assert.match(agent.messages[0].text, /message 2/)
  assert.doesNotMatch(agent.messages[0].text, /message 1/)
  await client.close()
})

test('the digest caps messages and reports the omissions', async () => {
  const { client, agent } = makeClient()
  client.deliver(Array.from({ length: 25 }, (_unused, index) => mail(index + 1)))
  client.tick(true)
  assert.equal(agent.messages.length, 1)
  assert.match(agent.messages[0].text, /25 new messages/)
  assert.match(agent.messages[0].text, /5 earlier messages omitted \(ab12cd\/1-5\)/)
  assert.equal(client.backlog().ab12cd.injected, 20, 'only the rendered messages stay in memory')
  assert.equal(agent.messages.length, 1)
  await client.close()
})

test('the spool is cleared only after a successful inject', async () => {
  const { client, spooled, advance } = makeClient()
  client.deliver([mail(1)])
  assert.equal(spooled.length, 1)
  advance(15_000)
  client.tick()
  assert.equal(spooled.length, 0)
  await client.close()
})

test('a failed inject keeps the messages and retries later', async () => {
  const { client, agent, advance } = makeClient()
  const original = agent.inject.bind(agent)
  let failures = 1
  agent.inject = (message) => {
    if (failures > 0) {
      failures -= 1
      throw new Error('queue write failed')
    }
    original(message)
  }
  client.deliver([mail(1)])
  advance(15_000)
  client.tick()
  assert.equal(agent.messages.length, 0)
  assert.equal(client.pending.length, 1)
  advance(1_000)
  client.tick()
  assert.equal(agent.messages.length, 1)
  await client.close()
})

test('a failed ack is retried without losing the batch', async () => {
  const { client, api } = makeClient()
  api.failAcks = 1
  client.deliver([mail(7)])
  await settle()
  assert.equal(api.ackCalls, 1)
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.deepEqual(api.acked, [7])
  await client.close()
})

test('a burst of concurrent deliveries yields one digest and one ack batch', async () => {
  const { client, agent, api, advance } = makeClient()
  client.deliver(Array.from({ length: 100 }, (_unused, index) => mail(index + 1)))
  assert.equal(client.pending.length, 20, 'receipt trimming keeps the buffer at the digest cap')
  advance(15_000)
  client.tick()
  assert.equal(agent.messages.length, 1)
  assert.match(agent.messages[0].text, /100 new messages/)
  await settle()
  assert.equal(api.acked.length, 100)
  assert.equal(new Set(api.acked).size, 100)
  await client.close()
})

test('registration is shared by concurrent callers', async () => {
  const { client, api } = makeClient()
  let registers = 0
  const original = api.register.bind(api)
  api.register = async (...args) => {
    registers += 1
    return original(...args)
  }
  const [first, second] = await Promise.all([client.ensureRegistered(), client.ensureRegistered()])
  assert.equal(first.username, second.username)
  assert.equal(registers, 1)
  await client.close()
})

test('unsubscribing drops buffered messages for that topic', async () => {
  const { client } = makeClient()
  client.deliver([mail(1), mail(2, { topicId: 'other1' })])
  assert.equal(client.pending.length, 2)
  await client.unsubscribe('ab12cd')
  assert.equal(client.pending.length, 1)
  assert.equal(client.pending[0].topicId, 'other1')
  await client.close()
})

test('spool replay seeds the dedupe set across a restart', async () => {
  const restored = { mailId: 99, topicId: 'ab12cd', messageId: 99, kind: 'post', author: 'peer', text: 'from spool', fileSize: null, parentId: null, toYou: false }
  const { client, advance } = makeClient({
    spool: {
      append: () => {},
      replace: () => {},
      load: () => [restored],
      clear: () => {},
    },
  })
  client.start()
  await client.ensureRegistered()
  assert.equal(client.pending.length, 1)
  client.deliver([{ ...restored }])
  assert.equal(client.pending.length, 1, 'a resent message is not duplicated')
  advance(15_000)
  client.tick()
  await client.close()
})

test('refresh drains pending and prevents a later inject', async () => {
  const { client, agent, spooled, advance } = makeClient()
  client.deliver([mail(1), mail(2)])
  assert.equal(spooled.length, 2)
  const pulled = client.refresh()
  assert.equal(pulled.count, 2)
  assert.match(pulled.text, /2 new messages/)
  assert.match(pulled.text, /message 1/)
  assert.match(pulled.text, /message 2/)
  assert.equal(client.pending.length, 0)
  assert.equal(spooled.length, 0)
  advance(60_000)
  client.tick()
  assert.equal(agent.messages.length, 0, 'pulled messages are never injected')
  assert.deepEqual(client.backlog(), {})
  await client.close()
})

test('refresh with nothing pending returns null', async () => {
  const { client } = makeClient()
  assert.equal(client.refresh(), null)
  await client.close()
})

test('refresh applies the digest caps', async () => {
  const { client } = makeClient()
  client.deliver(Array.from({ length: 25 }, (_unused, index) => mail(index + 1)))
  const pulled = client.refresh()
  assert.equal(pulled.shown, 20)
  assert.equal(pulled.omitted, 5)
  assert.match(pulled.text, /5 earlier messages omitted \(ab12cd\/1-5\)/)
  await client.close()
})

test('refresh leaves an already-injected digest alone', async () => {
  const { client, agent, advance } = makeClient()
  client.deliver([mail(1)])
  advance(15_000)
  client.tick()
  assert.equal(agent.messages.length, 1)
  client.deliver([mail(2)])
  const pulled = client.refresh()
  assert.match(pulled.text, /message 2/)
  assert.doesNotMatch(pulled.text, /message 1/)
  assert.equal(agent.messages.length, 1, 'the pending digest is untouched')
  assert.deepEqual(client.backlog(), { ab12cd: { injected: 1, pending: 0 } })
  await client.close()
})

test('pause stops delivery, inject and registration; resume restarts them', async () => {
  const { client, agent, api, advance } = makeClient()
  await client.ensureRegistered()
  assert.equal(api.registers, 1)

  await client.pause()
  assert.equal(client.paused, true)
  assert.equal(api.unregisters, 1)
  await assert.rejects(() => client.ensureRegistered(), error => error.code === 'SESSION_ARCHIVED')

  client.deliver([mail(1)])
  advance(60_000)
  client.tick()
  assert.equal(agent.messages.length, 0, 'a paused session never injects')

  client.resume()
  assert.equal(client.paused, false)
  await client.ensureRegistered()
  assert.equal(api.registers, 2, 'resume registers again')
  advance(60_000)
  client.tick()
  assert.equal(agent.messages.length, 1)
  await client.close()
})

test('a discarded digest is re-queued for the next turn', async () => {
  const { client, agent, spooled, advance } = makeClient()
  client.deliver([mail(1)])
  advance(15_000)
  client.tick()
  const digest = agent.messages[0]
  agent.messages.length = 0 // the loop removes the message before notifying
  client.onDiscarded(digest.id)
  assert.equal(client.pending.length, 1)
  assert.equal(spooled.length, 1, 'the requeued message is spooled again')
  assert.deepEqual(client.backlog(), { ab12cd: { injected: 0, pending: 1 } })

  advance(15_000)
  client.tick()
  assert.equal(agent.messages.length, 1)
  assert.match(agent.messages[0].text, /message 1/)
  await client.close()
})

test('discarding an unrelated message leaves the digest alone', async () => {
  const { client, agent, advance } = makeClient()
  client.deliver([mail(1)])
  advance(15_000)
  client.tick()
  const digest = agent.messages[0]
  client.onDiscarded('some-other-id')
  assert.equal(client.digest.messageId, digest.id)
  assert.equal(client.pending.length, 0)
  await client.close()
})

test('receipt trimming bounds the buffer while the agent runs', async () => {
  const { client, agent, advance } = makeClient({
    config: { coalesceMs: 15_000, mergeThrottleMs: 30_000, digestMaxMessages: 3, digestMaxChars: 8000 },
  })
  agent.status = 'running'
  client.deliver(Array.from({ length: 5 }, (_unused, index) => mail(index + 1)))
  assert.equal(client.pending.length, 3, 'only the newest three stay buffered')
  assert.equal(client.pendingDropped, 2)
  agent.status = 'idle'
  client.onStatus('idle')
  assert.equal(agent.messages.length, 1)
  assert.match(agent.messages[0].text, /5 new messages/)
  assert.match(agent.messages[0].text, /2 earlier messages omitted \(ab12cd\/1-2\)/)
  assert.equal(client.digest.messages.length, 3)
  assert.equal(client.digest.omitted, 2)
  await client.close()
})

test('merge totals keep counting messages dropped before the digest', async () => {
  const { client, agent, advance } = makeClient({
    config: { coalesceMs: 15_000, mergeThrottleMs: 30_000, digestMaxMessages: 3, digestMaxChars: 8000 },
  })
  client.deliver(Array.from({ length: 5 }, (_unused, index) => mail(index + 1)))
  advance(15_000)
  client.tick()
  assert.match(agent.messages[0].text, /5 new messages/)

  client.deliver([mail(6), mail(7)])
  advance(30_000)
  client.tick()
  assert.equal(agent.messages.length, 1)
  assert.match(agent.messages[0].text, /7 new messages/)
  assert.match(agent.messages[0].text, /4 earlier messages omitted \(ab12cd\/1-4\)/)
  assert.equal(client.digest.messages.length, 3)
  await client.close()
})

test('registration primes the subscription cache', async () => {
  const { client } = makeClient()
  await client.ensureRegistered()
  for (let attempt = 0; attempt < 50 && !client.subscriptionsKnown; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(client.subscriptionsKnown, true)
  assert.equal(client.subscribedCount, 0)
  await client.close()
})

test('topics() refreshes the cached subscription count', async () => {
  const { client, api } = makeClient()
  api.topicsResult = { subscribed: [{ id: 'abcd12', name: 'A' }], all: [] }
  await client.topics()
  assert.equal(client.subscriptionsKnown, true)
  assert.equal(client.subscribedCount, 1)
  await client.close()
})

test('unsubscribe refreshes the cached subscription count', async () => {
  const { client, api } = makeClient()
  api.topicsResult = { subscribed: [{ id: 'abcd12', name: 'A' }], all: [] }
  await client.topics()
  assert.equal(client.subscribedCount, 1)
  api.topicsResult = { subscribed: [], all: [] }
  await client.unsubscribe('abcd12')
  for (let attempt = 0; attempt < 50 && client.subscribedCount !== 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(client.subscriptionsKnown, true)
  assert.equal(client.subscribedCount, 0)
  await client.close()
})

test('an idle session is woken by a reply to one of its messages', async () => {
  const { client, agent } = makeClient()
  client.deliver([mail(1, { toYou: true })])
  client.tick()
  assert.equal(agent.woken.length, 1, 'the reply starts a turn')
  assert.equal(agent.messages.length, 1)
  assert.match(agent.messages[0].text, /\(to you\)/)
  assert.equal(client.pending.length, 0)
  await client.close()
})

test('an idle session is woken by a mention', async () => {
  const { client, agent } = makeClient()
  client.deliver([mail(1, { mentionYou: true, at: 'me' })])
  client.tick()
  assert.equal(agent.woken.length, 1)
  assert.match(agent.messages[0].text, /\(mention you\)/)
  await client.close()
})

test('broadcast traffic never wakes the session', async () => {
  const { client, agent, advance } = makeClient()
  client.deliver([mail(1, { at: 'someone-else' })])
  client.tick()
  assert.equal(agent.messages.length, 0, 'coalescing window still applies')
  advance(15_000)
  client.tick()
  assert.equal(agent.messages.length, 1)
  assert.equal(agent.woken.length, 0)
  await client.close()
})

test('a reply reaching a running turn is injected, never woken', async () => {
  const { client, agent } = makeClient()
  agent.status = 'running'
  client.deliver([mail(1, { toYou: true })])
  client.tick()
  assert.equal(agent.messages.length, 1, 'handed to the running turn')
  assert.equal(agent.woken.length, 0)
  assert.equal(client.digest.woke, false)
  await client.close()
})

test('a digest parked at the end of a running turn wakes on idle', async () => {
  const { client, agent } = makeClient()
  agent.status = 'running'
  client.deliver([mail(1, { mentionYou: true })])
  client.tick()
  assert.equal(agent.woken.length, 0)
  // The turn ends before a step boundary claims the digest.
  agent.status = 'idle'
  client.onStatus('idle')
  assert.equal(agent.woken.length, 1, 're-delivered as the follow-up turn it was meant to be')
  assert.match(agent.woken[0].text, /message 1/)
  assert.equal(agent.messages.length, 1, 'the parked copy was replaced, not duplicated')
  await client.close()
})

test('a claimed digest is not woken again', async () => {
  const { client, agent } = makeClient()
  agent.status = 'running'
  client.deliver([mail(1, { toYou: true })])
  client.tick()
  client.onClaimed(agent.messages[0].id)
  agent.status = 'idle'
  client.onStatus('idle')
  assert.equal(agent.woken.length, 0)
  await client.close()
})

test('every reply starts a turn: waking is not budgeted', async () => {
  const { client, agent } = makeClient()
  for (let i = 1; i <= 8; i += 1) {
    client.deliver([mail(i, { toYou: true })])
    client.tick()
    client.onClaimed(agent.messages[agent.messages.length - 1].id)
  }
  assert.equal(agent.woken.length, 8, 'no cooldown and no hourly cap on turns')
  await client.close()
})

test('injecting into a running turn is budgeted', async () => {
  const { client, agent, advance } = makeClient()
  agent.status = 'running'
  let injected = 0
  for (let i = 1; i <= 7; i += 1) {
    const before = agent.messages.length
    client.deliver([mail(i, { toYou: true })])
    client.tick()
    if (agent.messages.length > before) {
      injected += 1
      client.onClaimed(agent.messages[agent.messages.length - 1].id)
    }
    advance(61_000)
  }
  assert.equal(injected, 6, 'six injections inside the rolling hour')
  assert.equal(agent.woken.length, 0, 'a running turn is never woken')
  assert.equal(client.pending.length, 1, 'the seventh batch waits instead of growing the turn')
  // Once the turn ends, the leftover wakes the now-idle session, un-budgeted.
  agent.status = 'idle'
  client.onStatus('idle')
  assert.equal(agent.woken.length, 1)
  assert.match(agent.woken[0].text, /message 7/)
  await client.close()
})

test('a reply bypasses the merge throttle of a pending digest', async () => {
  const { client, agent, advance } = makeClient()
  client.deliver([mail(1)])
  advance(15_000)
  client.tick()
  assert.equal(agent.messages.length, 1)
  assert.equal(agent.woken.length, 0)
  advance(1_000)
  client.deliver([mail(2, { toYou: true })])
  client.tick()
  assert.equal(agent.woken.length, 1, 'merged and woken without waiting out the throttle')
  assert.equal(agent.messages.length, 1, 'the merged digest replaced the previous one')
  await client.close()
})

test('a host without followup keeps the reply as context', async () => {
  const { client, agent } = makeClient()
  agent.followup = undefined
  client.deliver([mail(1, { toYou: true })])
  client.tick()
  assert.equal(agent.messages.length, 1)
  assert.equal(agent.woken.length, 0)
  await client.close()
})

/**
 * A client whose fake host behaves like the real one: `followup` claims its
 * message synchronously (agent-loop kick -> turn -> preStep -> inbox.claim) and
 * `inbox.remove` emits `agent/inbox/discarded` synchronously.
 */
function makeHostClient(status = 'idle') {
  let time = 1_000_000
  let counter = 0
  const box = {}
  const agent = {
    status,
    messages: [],
    woken: [],
    inbox: {
      remove: (messageId) => {
        const index = agent.messages.findIndex(message => message.id === messageId)
        if (index === -1) return false
        agent.messages.splice(index, 1)
        box.client.onDiscarded(messageId)
        return true
      },
    },
    inject: (message) => { agent.messages.push(message) },
    followup: (message) => {
      agent.messages.push(message)
      agent.woken.push(message)
      box.client.onClaimed(message.id)
    },
  }
  const client = new SessionClient({
    ids: { installationId: 'host', sessionId: 'session' },
    agent,
    api: {
      register: async () => ({ username: 'test-user', limits: { contentMax: 100, ratePerMinute: 5, fileMaxBytes: 1000 } }),
      ack: async () => {},
      stream: async () => {},
      topics: async () => ({ subscribed: [], all: [] }),
      unregister: async () => {},
      setSubscription: async () => {},
    },
    spool: { append() {}, replace() {}, load: () => [], clear() {} },
    makeMessage: (text, count) => ({ id: `digest-${++counter}`, text, count }),
    config: { coalesceMs: 15_000, mergeThrottleMs: 30_000, digestMaxMessages: 20, digestMaxChars: 8000 },
    now: () => time,
  })
  box.client = client
  return { client, agent, advance: (ms) => { time += ms } }
}

test('a synchronously claimed follow-up leaves no phantom digest', async () => {
  const { client, agent } = makeHostClient()
  client.deliver([mail(1, { toYou: true })])
  client.tick()
  assert.equal(agent.woken.length, 1)
  assert.equal(client.digest, null, 'the claim cleared the entry instead of being ignored')
  await client.close()
})

test('a parked wake does not queue the digest it just re-delivered', async () => {
  const { client, agent } = makeHostClient('running')
  client.deliver([mail(1, { mentionYou: true })])
  client.tick()
  assert.equal(agent.woken.length, 0)
  agent.status = 'idle'
  client.onStatus('idle')
  assert.equal(agent.woken.length, 1)
  assert.equal(client.pending.length, 0, 'the removed copy is not queued again')
  assert.equal(client.digest, null)
  await client.close()
})

test('a mention to an idle session is scheduled without a coalescing window', async () => {
  const { client } = makeClient()
  client.deliver([mail(1, { toYou: true })])
  assert.ok(client.timer !== undefined && client.timer._idleTimeout <= 1, 'scheduled on the next tick, not after coalesceMs')
  await client.close()
})

test('a failed injection does not spend the running budget', async () => {
  const { client, agent } = makeClient()
  agent.status = 'running'
  const original = agent.inject.bind(agent)
  let calls = 0
  agent.inject = (message) => {
    calls += 1
    if (calls === 1) throw new Error('boom')
    original(message)
  }
  client.deliver([mail(1, { toYou: true })])
  client.tick()
  assert.equal(client.runningInjectTimes.length, 0)
  assert.equal(client.pending.length, 1)
  await client.close()
})
