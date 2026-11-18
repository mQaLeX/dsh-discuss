import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTopics, startStack } from './helpers.js'

const { dshAvailable } = await import('./dsh-links.js')
let plugin
let importError
if (dshAvailable) {
  try {
    plugin = await import('../admin/index.js')
  } catch (error) {
    importError = error
  }
}
const skip = plugin === undefined ? `DSH packages unavailable: ${importError ?? 'checkout missing'}` : false

function fakeContext() {
  const handlers = new Map()
  const presets = new Map()
  const agents = []
  const sections = []
  const cleanups = []
  return {
    presets,
    agents,
    sections,
    dispose() {
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup()
        } catch {
          // Cleanup failures do not mask the test result.
        }
      }
    },
    ctx: {
      logger: { warn() {}, error() {} },
      agents: { list: () => agents },
      get(name) {
        if (name !== 'agentPresets') return undefined
        return {
          presetForSession: session => presets.get(session.id) ?? null,
          composedPreset: () => undefined,
        }
      },
      on(event, handler) {
        handlers.set(event, handler)
      },
      systemPrompt: {
        section(definition) { sections.push(definition) },
      },
      effect(fn) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      },
    },
    emit(event, ...args) {
      const handler = handlers.get(event)
      assert.ok(handler, `no handler for ${event}`)
      handler(...args)
    },
  }
}

function fakeAgent(id, preset, origin = undefined) {
  const tools = []
  return {
    session: { id, header: { agentPreset: preset, origin } },
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
    tools,
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function tokenOf(text) {
  const match = /Create token: (\S+)/.exec(text)
  assert.ok(match, `no token in: ${text}`)
  return match[1]
}

test('admin tools are registered only for the admin preset', { skip }, async () => {
  const stack = await startStack({ adminTokenTtlMs: 5000 })
  try {
    const fake = fakeContext()
    plugin.apply(fake.ctx, { adminServer: stack.adminBase })

    const standard = fakeAgent('std-session', 'standard')
    fake.emit('agent/created', { agent: standard })
    assert.equal(standard.tools.length, 0)

    const subagent = fakeAgent('sub-session', 'discuss-admin', 'subagent')
    fake.emit('agent/created', { agent: subagent })
    assert.equal(subagent.tools.length, 0)

    const agent = fakeAgent('admin-session', 'discuss-admin')
    fake.emit('agent/created', { agent })
    assert.equal(agent.tools.length, 3)
    const byName = new Map(agent.tools.map(tool => [tool.name, tool]))
    const call = (name, args = {}) => byName.get(name).execute(args, {
      agent: undefined,
      signal: AbortSignal.timeout(5000),
    })

    const listed = await call('discuss_admin_list_topics')
    assert.match(listed.text, /Topics \(\d+\):/)

    const requested = await call('discuss_admin_request_create')
    const token = tokenOf(requested.text)
    assert.match(requested.text, /valid \d+s/)
    assert.match(requested.text, /Existing topics/)

    await assert.rejects(
      () => call('discuss_admin_request_create'),
      error => String(error.message).includes('TOKEN_HELD'),
    )

    const confirmed = await call('discuss_admin_confirm_create', {
      token,
      names: ['admin flow topic', 'admin flow topic two'],
    })
    assert.match(confirmed.text, /created [a-z2-7]+ {2}admin flow topic/)
    assert.match(confirmed.text, /admin flow topic two/)

    await assert.rejects(
      () => call('discuss_admin_confirm_create', { token, names: ['never'] }),
      error => String(error.message).includes('TOKEN_EXPIRED'),
    )
  } finally {
    await stack.close()
  }
})

test('admin tools follow the preset projection and live switches', { skip }, async () => {
  const stack = await startStack({ adminTokenTtlMs: 5000 })
  try {
    const fake = fakeContext()
    plugin.apply(fake.ctx, { adminServer: stack.adminBase })

    // Header says standard (creation fact), projection says discuss-admin.
    const switched = fakeAgent('admin-switched', 'standard')
    fake.presets.set('admin-switched', 'discuss-admin')
    fake.agents.push(switched)
    fake.emit('agent/created', { agent: switched })
    assert.equal(switched.tools.length, 3)

    // Header says discuss-admin, projection says standard: no tools.
    const excluded = fakeAgent('admin-excluded', 'discuss-admin')
    fake.presets.set('admin-excluded', 'standard')
    fake.agents.push(excluded)
    fake.emit('agent/created', { agent: excluded })
    assert.equal(excluded.tools.length, 0)

    // A live switch registers, and switching away unregisters.
    const live = fakeAgent('admin-live', 'standard')
    fake.presets.set('admin-live', 'standard')
    fake.agents.push(live)
    fake.emit('agent/created', { agent: live })
    assert.equal(live.tools.length, 0)
    fake.presets.set('admin-live', 'discuss-admin')
    fake.emit('agent-preset/selected', 'admin-live', 'discuss-admin')
    assert.equal(live.tools.length, 3)
    fake.presets.set('admin-live', 'standard')
    fake.emit('agent-preset/selected', 'admin-live', 'standard')
    assert.equal(live.tools.length, 0)
  } finally {
    await stack.close()
  }
})

test('the admin prompt is injected only for admin sessions', { skip }, async () => {
  const fake = fakeContext()
  plugin.apply(fake.ctx, { adminServer: 'http://127.0.0.1:7802' })
  const section = fake.sections[0]
  assert.ok(section, 'the plugin registers one prompt section')
  assert.equal(section.name, 'dsh-discuss-admin')
  assert.equal(section.order, 61)

  const textFor = (preset, origin) => section.text({
    agent: { session: { id: 'prompt-session', header: { agentPreset: preset, origin } } },
  })
  const text = textFor('discuss-admin')
  assert.match(text, /Reach the board only through the `discuss_admin_\*` tools/)
  assert.match(text, /A topic exists by meaning, not by string/)
  assert.match(text, /tell the human before creating/)
  assert.match(text, /TOKEN_HELD/)
  assert.match(text, /Deletion is not a tool/)
  assert.doesNotMatch(text, /settle the final names/i, 'names are a workspace rule, not prompt text')

  assert.equal(textFor('standard'), '')
  assert.equal(textFor('discuss-admin', 'subagent'), '')
})

test('the admin plugin declares every service it reads', { skip }, () => {
  // Cordis throws when the plugin touches a service it did not inject; the
  // prompt section needs `systemPrompt` beside the agent registry.
  assert.ok(plugin.inject.includes('agents'))
  assert.ok(plugin.inject.includes('systemPrompt'))
})

test('an admin plugin reload leaves no tool registrations behind', { skip }, async () => {
  const fake = fakeContext()
  plugin.apply(fake.ctx, { adminServer: 'http://127.0.0.1:7802' })
  const agent = fakeAgent('admin-reload', 'discuss-admin')
  fake.agents.push(agent)
  fake.emit('agent/created', { agent })
  assert.equal(agent.tools.length, 3)

  fake.dispose()
  assert.equal(agent.tools.length, 0)
})
