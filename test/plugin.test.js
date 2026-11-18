import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { createTopics, fakeHolder, post, register, request, startStack, subscribe } from './helpers.js'
import { listHolders, pendingMail } from '../server/store.js'

// The Host plugin imports DSH packages that only the installed harness
// provides; link the local checkout when it is present, otherwise skip.
const { dshAvailable } = await import('./dsh-links.js')
let plugin
let importError
if (dshAvailable) {
  try {
    plugin = await import('../client/src/plugin.js')
  } catch (error) {
    importError = error
  }
}
const skip = plugin === undefined ? `DSH packages unavailable: ${importError ?? 'checkout missing'}` : false

/**
 * @param {string} id
 * @param {string} cwd
 */
function fakeAgent(id, cwd, preset = 'discuss') {
  const messages = []
  const tools = []
  return {
    session: { id, header: { cwd, origin: undefined, agentPreset: preset } },
    status: 'idle',
    messages,
    tools,
    ctx: {
      tools: {
        register(definition) {
          tools.push(definition)
          return () => {
            const index = tools.indexOf(definition)
            if (index !== -1) tools.splice(index, 1)
          }
        },
      },
    },
    inject(message) {
      messages.push(message)
    },
    inbox: {
      remove(messageId) {
        const index = messages.findIndex(message => message.id === messageId)
        if (index === -1) return false
        messages.splice(index, 1)
        return true
      },
    },
  }
}

function fakeContext() {
  const handlers = new Map()
  const cleanups = []
  const presets = new Map()
  const agents = []
  const workspaceRegistry = { archivedSessionIds: [] }
  let section
  let route
  const fs = {
    async resolve(path, options = {}) {
      return resolve(options.cwd ?? process.cwd(), path)
    },
    async stat(target) {
      try {
        return { size: statSync(target).size }
      } catch {
        return undefined
      }
    },
    async readByteRange(target, range) {
      const fd = openSync(target, 'r')
      try {
        const buffer = Buffer.alloc(range.length)
        const read = readSync(fd, buffer, 0, range.length, range.offset)
        return new Uint8Array(buffer.subarray(0, read))
      } finally {
        closeSync(fd)
      }
    },
  }
  return {
    dispose() {
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup()
        } catch {
          // Cleanup failures do not mask the test result.
        }
      }
    },
    workspaceRegistry,
    ctx: {
      logger: { warn() {}, error() {} },
      agents: { list: () => agents },
      get(name) {
        if (name === 'workspaceRegistry') return workspaceRegistry
        if (name === 'agentPresets') {
          return {
            presetForSession: session => presets.get(session.id) ?? null,
            composedPreset: () => undefined,
          }
        }
        return undefined
      },
      on(event, handler) {
        handlers.set(event, handler)
      },
      systemPrompt: {
        section(value) {
          section = value
        },
      },
      effect(fn) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      },
      inject(deps, callback) {
        if (!deps.includes('webServer')) return
        callback({
          effect(fn) {
            const cleanup = fn()
            if (typeof cleanup === 'function') cleanups.push(cleanup)
          },
          webServer: {
            register(value) {
              route = value
              return () => {}
            },
          },
        })
      },
      fs,
    },
    handlers,
    presets,
    agents,
    section: () => section,
    route: () => route,
  }
}

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition not met in time')
}

test('plugin integrates with a real server and a fake agent', { skip }, async () => {
  const stack = await startStack({ ratePerMinute: 100 })
  const [topic] = await createTopics(stack.adminBase, ['plugin integration'])
  const fake = fakeContext()
  const tempRoot = join(stack.dir, 'plugin')
  const configPath = join(tempRoot, 'config.json')
  try {
    plugin.apply(fake.ctx, {
      configPath,
      server: stack.base,
      coalesceMs: 30,
      mergeThrottleMs: 60,
      digestMaxMessages: 20,
      formRefreshSeconds: 10,
      storeDir: join(stack.dir, 'store'),
    })

    const agent = fakeAgent('pl-session', stack.dir)
    const installationId = JSON.parse(readFileSync(configPath, 'utf8')).installationId
    fake.handlers.get('agent/created')({ agent })

    assert.equal(agent.tools.length, 11, 'eleven discuss tools are registered')

    // On-demand prompt: a session with no subscriptions pays no prompt tokens.
    await until(() => fake.section().text({ agent }) === '', 3000)

    // Subscribe both the agent session and a peer through the public API.
    const peer = { installationId: 'peer-host', sessionId: 'peer-session' }
    await register(stack.base, peer.installationId, peer.sessionId)
    await subscribe(stack.base, peer, topic.id)
    await until(async () => {
      const response = await fetch(`${stack.base}/v1/topics?installationId=${installationId}&sessionId=pl-session`)
      const body = await response.json()
      return body.ok === true
    })
    await subscribe(stack.base, { installationId, sessionId: 'pl-session' }, topic.id)

    // A peer post reaches the agent as one injected digest.
    await post(stack.base, peer, topic.id, 'hello from peer')
    await until(() => agent.messages.length > 0)
    assert.match(agent.messages[0].content[0].text, /hello from peer/)
    assert.match(agent.messages[0].content[0].text, /1 new message/)

    // Claiming the digest clears the backlog (the loop removes it from the inbox first).
    const digest = agent.messages[0]
    agent.messages.length = 0
    fake.handlers.get('agent/inbox/claimed')({ agent, message: digest })
    assert.equal(agent.messages.length, 0)

    // While running, delivery buffers; discuss_refresh pulls it into the turn.
    agent.status = 'running'
    await post(stack.base, peer, topic.id, 'buffered while running')
    await new Promise(resolve => setTimeout(resolve, 400))
    const refreshTool = agent.tools.find(tool => tool.name === 'discuss_refresh')
    const pulled = await refreshTool.execute({}, { agent, signal: AbortSignal.timeout(5000) })
    assert.match(pulled.text, /buffered while running/)
    const empty = await refreshTool.execute({}, { agent, signal: AbortSignal.timeout(5000) })
    assert.match(empty.text, /No new messages/)
    agent.status = 'idle'

    // discuss_post writes through to the server.
    const postTool = agent.tools.find(tool => tool.name === 'discuss_post')
    const result = await postTool.execute(
      { topicId: topic.id, content: 'from the plugin' },
      { agent, signal: AbortSignal.timeout(5000) },
    )
    assert.match(result.text, new RegExp(`Posted ${topic.id}/\\d+`))

    const history = await fetch(`${stack.base}/v1/history/${topic.id}?installationId=peer-host&sessionId=peer-session`)
    assert.match(await history.text(), /from the plugin/)

    // whoami reflects the registration.
    const whoami = agent.tools.find(tool => tool.name === 'discuss_whoami')
    const identity = await whoami.execute({}, { agent, signal: AbortSignal.timeout(5000) })
    assert.match(identity.text, /^You are @[a-z]+-[a-z]+-[0-9a-f]{2} on the board\.$/)

    // Refreshing the topic list flips the prompt section back on.
    const listTool = agent.tools.find(tool => tool.name === 'discuss_list_topics')
    await listTool.execute({}, { agent, signal: AbortSignal.timeout(5000) })

    // The prompt section renders the username and limits.
    const prompt = fake.section().text({ agent })
    assert.match(prompt, /# dsh-discuss/)
    assert.match(prompt, /@[a-z]+-[a-z]+-[0-9a-f]{2}/)
    assert.match(prompt, /500 characters/)

    // The session form route answers the browser.
    const route = fake.route()
    assert.equal(route.path, '/discuss/api')
    const res = {
      status: 0,
      body: '',
      writeHead(status) { this.status = status },
      end(payload) { this.body = payload },
    }
    await route.handler(
      { url: '/discuss/api/state?sessionId=pl-session', method: 'GET' },
      res,
      { principal: { kind: 'owner' } },
    )
    assert.equal(res.status, 200)
    const state = JSON.parse(res.body)
    assert.equal(state.ok, true)
    assert.ok(state.topics.some(entry => entry.id === topic.id && entry.subscribed === true))
    assert.deepEqual(state.backlog, {})
    assert.equal(state.refreshSeconds, 10)

    // A discuss-preset session whose board client has not attached yet answers
    // `pending`: the switch from standard to discuss mounts the composition
    // before the client exists, and the panel must show that state instead of
    // staying hidden until its next slow refresh tick.
    const answer = async (url) => {
      const target = {
        status: 0,
        body: '',
        writeHead(status) { this.status = status },
        end(payload) { this.body = payload },
      }
      // Older DSH releases call route handlers with (req, res) only, so the
      // panel route must answer with or without a Peer.
      await route.handler({ url, method: 'GET' }, target)
      return target
    }
    const pendingAgent = fakeAgent('pl-pending', stack.dir)
    fake.agents.push(pendingAgent)
    const pendingRes = await answer('/discuss/api/state?sessionId=pl-pending')
    assert.equal(pendingRes.status, 200)
    assert.equal(JSON.parse(pendingRes.body).pending, true)

    // Any other preset keeps the panel hidden: no client and no pending guess.
    const standardAgent = fakeAgent('pl-standard', stack.dir, 'standard')
    fake.agents.push(standardAgent)
    const standardRes = await answer('/discuss/api/state?sessionId=pl-standard')
    assert.equal(standardRes.status, 404)
    const unknownRes = await answer('/discuss/api/state?sessionId=pl-unknown')
    assert.equal(unknownRes.status, 404)

    // Subscribing and unsubscribing from the form forwards to the server.
    const toggleRes = {
      status: 0,
      body: '',
      writeHead(status) { this.status = status },
      end(payload) { this.body = payload },
    }
    const body = JSON.stringify({ sessionId: 'pl-session', topicId: topic.id, subscribed: false })
    await route.handler(
      {
        url: '/discuss/api/subscription',
        method: 'POST',
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(body)
        },
      },
      toggleRes,
      { principal: { kind: 'owner' } },
    )
    assert.equal(toggleRes.status, 200)
    const after = await fetch(`${stack.base}/v1/topics?installationId=${installationId}&sessionId=pl-session`)
    const afterBody = await after.json()
    assert.equal(afterBody.subscribed.some(entry => entry.id === topic.id), false)

    // Archiving pauses delivery and unregisters; unarchiving resumes both.
    await subscribe(stack.base, { installationId, sessionId: 'pl-session' }, topic.id)
    const activeFlag = () => stack.db.prepare(
      'SELECT active FROM sessions WHERE installation_id = ? AND session_id = ?',
    ).get(installationId, 'pl-session')?.active
    assert.equal(activeFlag(), 1)
    fake.workspaceRegistry.archivedSessionIds.push('pl-session')
    fake.handlers.get('workspace/session-archived')({ sessionId: 'pl-session' })
    await until(() => activeFlag() === 0)
    fake.workspaceRegistry.archivedSessionIds.length = 0
    fake.handlers.get('workspace/session-unarchiving')({ sessionId: 'pl-session' })
    await until(() => activeFlag() === 1)

    // A digest the loop discards (cancellation) is re-queued and re-injected.
    agent.messages.length = 0
    await post(stack.base, peer, topic.id, 'discard me')
    await until(() => agent.messages.length > 0)
    const discardedDigest = agent.messages[0]
    agent.messages.length = 0
    fake.handlers.get('agent/inbox/discarded')({ agent, message: discardedDigest })
    await until(() => agent.messages.length > 0)
    assert.match(agent.messages[0].content[0].text, /discard me/)

    // Disposal unregisters the mailbox.
    fake.handlers.get('agent/disposed')({ agent })
    await new Promise(resolve => setTimeout(resolve, 100))
  } finally {
    fake.dispose()
    await stack.close()
  }
})

test('files are imported, shared and served from the local store', { skip }, async () => {
  const stack = await startStack({ ratePerMinute: 100, contentMax: 1000 })
  const topic = (await createTopics(stack.adminBase, ['file relay']))[0]
  const fake = fakeContext()
  const configPath = join(stack.dir, 'file-id.json')
  let agent
  try {
    plugin.apply(fake.ctx, {
      configPath,
      server: stack.base,
      storeDir: join(stack.dir, 'file-store'),
      coalesceMs: 30,
      mergeThrottleMs: 60,
    })
    agent = fakeAgent('file-session', stack.dir)
    fake.handlers.get('agent/created')({ agent })
    const installationId = JSON.parse(readFileSync(configPath, 'utf8')).installationId
    await register(stack.base, installationId, 'file-session')
    await subscribe(stack.base, { installationId, sessionId: 'file-session' }, topic.id)

    const payload = Buffer.from('offline package payload')
    writeFileSync(join(stack.dir, 'pkg.bin'), payload)

    const shareTool = agent.tools.find(tool => tool.name === 'discuss_share_file')
    const shared = await shareTool.execute(
      { topicId: topic.id, sourcePath: 'pkg.bin', intro: 'package' },
      { agent, signal: AbortSignal.timeout(5000) },
    )
    const messageId = Number(/Shared [a-z2-7]+\/(\d+)/.exec(shared.text)?.[1])
    assert.ok(messageId > 0, shared.text)

    const requestTool = agent.tools.find(tool => tool.name === 'discuss_request_file')
    const requested = await requestTool.execute(
      { topicId: topic.id, messageId, savePath: 'out/pkg.bin' },
      { agent, signal: AbortSignal.timeout(10_000) },
    )
    assert.match(requested.text, /local store/)
    assert.deepEqual(readFileSync(join(stack.dir, 'out/pkg.bin')), payload)
    assert.deepEqual(listHolders(stack.db, topic.id, messageId), [installationId])
  } finally {
    if (agent !== undefined) fake.handlers.get('agent/disposed')?.({ agent })
    fake.dispose()
    await stack.close()
  }
})

test('discuss_request_file relays a file this host does not hold', { skip }, async () => {
  const stack = await startStack({ ratePerMinute: 100, contentMax: 1000 })
  const topic = (await createTopics(stack.adminBase, ['remote file']))[0]
  const holder = { installationId: 'remote-holder', sessionId: 'h' }
  const payload = Buffer.from('remote package payload')
  const sha = createHash('sha256').update(payload).digest('hex')
  await register(stack.base, holder.installationId, holder.sessionId)
  await subscribe(stack.base, holder, topic.id)
  const shared = await request(`${stack.base}/v1/messages/file`, {
    ...holder, topicId: topic.id, kind: 'post', requestId: crypto.randomUUID(),
    intro: 'remote package', fileSha256: sha, fileSize: payload.length,
  })
  assert.equal(shared.status, 200)
  const messageId = shared.body.id
  const server = fakeHolder({
    base: stack.base,
    installationId: holder.installationId,
    files: new Map([[`${topic.id}/${messageId}`, payload]]),
  })
  await server.ready
  const fake = fakeContext()
  const configPath = join(stack.dir, 'remote-id.json')
  let agent
  try {
    plugin.apply(fake.ctx, {
      configPath,
      server: stack.base,
      storeDir: join(stack.dir, 'remote-store'),
      coalesceMs: 30,
    })
    agent = fakeAgent('remote-session', stack.dir)
    fake.handlers.get('agent/created')({ agent })
    const installationId = JSON.parse(readFileSync(configPath, 'utf8')).installationId
    await register(stack.base, installationId, 'remote-session')
    await subscribe(stack.base, { installationId, sessionId: 'remote-session' }, topic.id)
    const requestTool = agent.tools.find(tool => tool.name === 'discuss_request_file')
    let result
    await until(async () => {
      try {
        result = await requestTool.execute(
          { topicId: topic.id, messageId, savePath: 'out/remote.bin' },
          { agent, signal: AbortSignal.timeout(10_000) },
        )
        return true
      } catch (error) {
        if (String(error.message).includes('FILE_UNAVAILABLE')) return false
        throw error
      }
    }, 5000)
    assert.ok(result !== undefined)
    assert.doesNotMatch(result.text, /local store/)
    assert.deepEqual(readFileSync(join(stack.dir, 'out/remote.bin')), payload)
  } finally {
    if (agent !== undefined) fake.handlers.get('agent/disposed')?.({ agent })
    fake.dispose()
    server.close()
    await stack.close()
  }
})

test('a share_comment conflict fails loudly and can be retargeted', { skip }, async () => {
  const stack = await startStack({ ratePerMinute: 100, contentMax: 1000 })
  const topic = (await createTopics(stack.adminBase, ['file reply conflict']))[0]
  const fake = fakeContext()
  const configPath = join(stack.dir, 'conflict-id.json')
  let agent
  try {
    plugin.apply(fake.ctx, {
      configPath,
      server: stack.base,
      storeDir: join(stack.dir, 'conflict-store'),
      coalesceMs: 30,
    })
    agent = fakeAgent('conflict-session', stack.dir)
    fake.handlers.get('agent/created')({ agent })
    const installationId = JSON.parse(readFileSync(configPath, 'utf8')).installationId
    const self = { installationId, sessionId: 'conflict-session' }
    const peer = { installationId: 'conflict-peer', sessionId: 'p' }
    await register(stack.base, self.installationId, self.sessionId)
    await subscribe(stack.base, self, topic.id)
    await register(stack.base, peer.installationId, peer.sessionId)
    await subscribe(stack.base, peer, topic.id)

    const root = await post(stack.base, peer, topic.id, 'root')
    const reply = await post(stack.base, self, topic.id, 'text reply', { parentId: root.body.id })
    writeFileSync(join(stack.dir, 'conflict.bin'), 'conflict payload')

    const shareTool = agent.tools.find(tool => tool.name === 'discuss_share_comment')
    const execute = messageId => shareTool.execute(
      { topicId: topic.id, sourcePath: 'conflict.bin', intro: 'payload', messageId },
      { agent, signal: AbortSignal.timeout(5000) },
    )

    await assert.rejects(execute(root.body.id), error => {
      const payload = JSON.parse(error.message)
      assert.equal(payload.error.code, 'COMMENT_EXISTS')
      assert.match(payload.error.message, /your earlier reply/)
      return true
    })
    // The rejected share did not create a message.
    const count = stack.db.prepare('SELECT COUNT(*) AS c FROM messages WHERE topic_id = ?').get(topic.id).c
    assert.equal(count, 2)

    // Retargeting the file at the earlier reply works and registers a holder.
    const attached = await execute(reply.body.id)
    const messageId = Number(/Shared [a-z2-7]+\/(\d+)/.exec(attached.text)?.[1])
    assert.ok(messageId > 0, attached.text)
    assert.deepEqual(listHolders(stack.db, topic.id, messageId), [installationId])

    // Re-announcing the same file is an idempotent duplicate, not a conflict.
    const again = await execute(reply.body.id)
    assert.match(again.text, /Already shared/)
  } finally {
    if (agent !== undefined) fake.handlers.get('agent/disposed')?.({ agent })
    fake.dispose()
    await stack.close()
  }
})

test('discuss_post passes an at mention through', { skip }, async () => {
  const stack = await startStack({ ratePerMinute: 100 })
  const topic = (await createTopics(stack.adminBase, ['tool mentions']))[0]
  const fake = fakeContext()
  const configPath = join(stack.dir, 'mention-id.json')
  let agent
  try {
    plugin.apply(fake.ctx, {
      configPath,
      server: stack.base,
      storeDir: join(stack.dir, 'mention-store'),
      coalesceMs: 30,
    })
    agent = fakeAgent('mention-session', stack.dir)
    fake.handlers.get('agent/created')({ agent })
    const installationId = JSON.parse(readFileSync(configPath, 'utf8')).installationId
    const self = { installationId, sessionId: 'mention-session' }
    const peer = { installationId: 'mention-peer', sessionId: 'p' }
    await register(stack.base, self.installationId, self.sessionId)
    await subscribe(stack.base, self, topic.id)
    const peerName = (await register(stack.base, peer.installationId, peer.sessionId)).body.username
    await subscribe(stack.base, peer, topic.id)

    const postTool = agent.tools.find(tool => tool.name === 'discuss_post')
    const result = await postTool.execute(
      { topicId: topic.id, content: 'ping', at: `@${peerName}` },
      { agent, signal: AbortSignal.timeout(5000) },
    )
    assert.match(result.text, new RegExp(`at @${peerName}`))
    const mail = pendingMail(stack.db, peer).find(row => row.payload.text === 'ping')
    assert.equal(mail.payload.at, peerName)
    assert.equal(mail.payload.mentionYou, true)
  } finally {
    if (agent !== undefined) fake.handlers.get('agent/disposed')?.({ agent })
    fake.dispose()
    await stack.close()
  }
})

test('a standard-preset session gets no discuss tools', { skip }, async () => {
  const stack = await startStack({ ratePerMinute: 100 })
  const fake = fakeContext()
  try {
    plugin.apply(fake.ctx, {
      configPath: join(stack.dir, 'std-id.json'),
      server: stack.base,
      storeDir: join(stack.dir, 'std-store'),
      coalesceMs: 30,
    })
    const agent = fakeAgent('std-session', stack.dir, 'standard')
    fake.handlers.get('agent/created')({ agent })
    assert.equal(agent.tools.length, 0)
    assert.equal(agent.messages.length, 0)
    assert.equal(fake.section().text({ agent }), '')
    await new Promise(resolve => setTimeout(resolve, 100))
  } finally {
    fake.dispose()
    await stack.close()
  }
})

test('the agentPreset projection, not the frozen header, selects the mode', { skip }, async () => {
  const stack = await startStack({ ratePerMinute: 100 })
  const fake = fakeContext()
  try {
    plugin.apply(fake.ctx, {
      configPath: join(stack.dir, 'proj-id.json'),
      server: stack.base,
      storeDir: join(stack.dir, 'proj-store'),
      coalesceMs: 30,
    })

    // Header says standard (the creation fact), projection says discuss.
    const switched = fakeAgent('switched-session', stack.dir, 'standard')
    fake.presets.set('switched-session', 'discuss')
    fake.agents.push(switched)
    fake.handlers.get('agent/created')({ agent: switched })
    assert.equal(switched.tools.length, 11, 'the projection wins over the header')

    // Header says discuss, projection says standard: no tools.
    const excluded = fakeAgent('excluded-session', stack.dir, 'discuss')
    fake.presets.set('excluded-session', 'standard')
    fake.agents.push(excluded)
    fake.handlers.get('agent/created')({ agent: excluded })
    assert.equal(excluded.tools.length, 0, 'a switched-away session loses the tools')

    // Live switch after creation: the registry event attaches the client.
    const live = fakeAgent('live-session', stack.dir, 'standard')
    fake.presets.set('live-session', 'standard')
    fake.agents.push(live)
    fake.handlers.get('agent/created')({ agent: live })
    assert.equal(live.tools.length, 0)
    fake.presets.set('live-session', 'discuss')
    fake.handlers.get('agent-preset/selected')('live-session', 'discuss')
    assert.equal(live.tools.length, 11, 'a live preset switch attaches the tools')

    // Switching away disposes them again.
    fake.presets.set('live-session', 'standard')
    fake.handlers.get('agent-preset/selected')('live-session', 'standard')
    assert.equal(live.tools.length, 0, 'switching away unregisters the tools')
    await new Promise(resolve => setTimeout(resolve, 50))
  } finally {
    fake.dispose()
    await stack.close()
  }
})
