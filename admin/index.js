import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-discuss-admin'
export const inject = ['agents']

/** Admin settings: the endpoint and the preset allowed to see these tools. */
export const Config = z.object({
  adminServer: z.string().default('').description(
    'Admin server URL, for example http://192.168.1.10:7802. Required.',
  ),
  adminPreset: z.string().default('discuss-admin').description(
    'Agent preset id whose sessions get the admin tools; empty disables the gate.',
  ),
})

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true, description: 'Model-facing result.' },
  },
}

/**
 * Admin endpoint. Every client setting lives in the plugin config now; the
 * per-host installationId.json only carries the identity.
 * @param {Record<string, any>} config
 * @returns {string | undefined}
 */
function resolveAdminBase(config) {
  const value = config.adminServer
  return typeof value === 'string' && value.length > 0 ? value.replace(/\/$/, '') : undefined
}

/**
 * @param {unknown} error
 * @returns {Error}
 */
function fail(error) {
  if (error instanceof Error && error.message.startsWith('{"ok":false')) return error
  const message = error instanceof Error ? error.message : String(error)
  return new Error(JSON.stringify({ ok: false, error: { code: 'SERVER_UNREACHABLE', message, retryable: true } }))
}

/**
 * @param {any} ctx
 * @param {Record<string, any>} [config]
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const adminPreset = typeof config.adminPreset === 'string' ? config.adminPreset : 'discuss-admin'
  const base = resolveAdminBase(config)
  if (base === undefined) {
    logger.error?.('dsh-discuss-admin: adminServer is missing from the plugin config; plugin disabled')
    return
  }

  /**
   * @param {string} path
   * @param {unknown} [body]
   */
  async function call(path, body) {
    let response
    try {
      response = await fetch(new URL(path, base), {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      throw new Error(JSON.stringify({
        ok: false,
        error: { code: 'SERVER_UNREACHABLE', message: `cannot reach ${base}: ${String(error)}`, retryable: true },
      }))
    }
    const text = await response.text()
    let parsed
    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (!response.ok) {
      const error = parsed?.error ?? { code: 'INTERNAL', message: `HTTP ${response.status}` }
      throw new Error(JSON.stringify({ ok: false, error }))
    }
    return parsed
  }

  /**
   * @param {string} toolName
   * @param {string} description
   * @param {Record<string, any>} parameters
   * @param {(args: any) => Promise<string>} run
   */
  function tool(toolName, description, parameters, run) {
    return defineTool({
      name: toolName,
      description,
      parameters,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        try {
          return { text: await run(args) }
        } catch (error) {
          throw fail(error)
        }
      },
    })
  }

  function renderTopics(topics) {
    if (topics.length === 0) return '(no topics exist yet)'
    return topics.map(topic => `- ${topic.id}  ${topic.name}`).join('\n')
  }

  const adminTools = [
    tool(
      'discuss_admin_list_topics',
      'List every topic on the board, subscribed or not.',
      {},
      async () => {
        const body = await call('/v1/admin/topics')
        const topics = Array.isArray(body.topics) ? body.topics : []
        return `Topics (${topics.length}):\n${renderTopics(topics)}`
      },
    ),
    tool(
      'discuss_admin_request_create',
      'Take the single create token and return the current topic list. While another create request holds it this fails with TOKEN_HELD; retry after the reported delay instead of busy-looping.',
      {},
      async () => {
        const body = await call('/v1/admin/topics/request', {})
        const topics = Array.isArray(body.topics) ? body.topics : []
        const seconds = Math.max(0, Math.round((body.expiresAt - Date.now()) / 1000))
        return [
          `Create token: ${body.token} (valid ${seconds}s)`,
          `Existing topics (${topics.length}):`,
          renderTopics(topics),
          '',
          'Confirm with discuss_admin_confirm_create, passing the names you want and this token. The token is spent whatever the result.',
        ].join('\n')
      },
    ),
    tool(
      'discuss_admin_confirm_create',
      'Create every named topic in one transaction. Returns created/existing for each name; the token is always invalidated.',
      {
        token: { type: 'string', required: true, description: 'Token from discuss_admin_request_create.' },
        names: {
          type: 'array',
          required: true,
          description: 'Topic names to create, 1-50 entries.',
          items: { type: 'string', description: 'One topic name.' },
        },
      },
      async (args) => {
        const body = await call('/v1/admin/topics/confirm', { token: args.token, names: args.names })
        const results = Array.isArray(body.results) ? body.results : []
        return [
          'Create result:',
          ...results.map(row => `- ${row.status} ${row.id}  ${row.name}`),
          '',
          'The token is now invalid. Agents join by the human toggling the topic in their session panel.',
        ].join('\n')
      },
    ),
  ]

  /** @type {Map<string, Array<() => void>>} */
  const toolDisposers = new Map()

  /**
   * The live preset of an agent. The session header records the preset the
   * session started with and is deep-frozen; a switch appends an
   * `agent-preset/selected` event. Read the recorded preset or live
   * composition, and fall back to the header only when neither exists.
   * @param {any} agent
   * @returns {string | undefined}
   */
  function presetOf(agent) {
    const registry = ctx.get?.('agentPresets')
    const projected = registry?.presetForSession?.(agent.session)
    if (typeof projected === 'string') return projected
    const composed = registry?.composedPreset?.(agent.ctx)
    if (typeof composed === 'string') return composed
    return agent.session?.header?.agentPreset
  }

  /**
   * @param {string} sessionId
   */
  function detach(sessionId) {
    const disposers = toolDisposers.get(sessionId)
    if (disposers === undefined) return
    toolDisposers.delete(sessionId)
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // The agent scope is already gone.
      }
    }
  }

  /**
   * @param {any} agent
   * @param {string} [presetOverride] event payload, before the composition settles
   */
  function registerFor(agent, presetOverride) {
    if (agent.session?.header?.origin === 'subagent') return
    const preset = presetOverride ?? presetOf(agent)
    if (adminPreset !== '' && preset !== undefined && preset !== adminPreset) return
    const registry = agent.ctx?.tools
    if (registry === undefined) return
    if (toolDisposers.has(agent.session.id)) return
    const disposers = []
    for (const definition of adminTools) disposers.push(registry.register(definition))
    toolDisposers.set(agent.session.id, disposers)
  }

  for (const agent of ctx.agents.list()) registerFor(agent)
  ctx.on('agent/created', ({ agent }) => registerFor(agent), { global: true })
  ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
    if (adminPreset !== '' && agentPreset !== adminPreset) {
      detach(sessionId)
      return
    }
    const agent = ctx.agents.list().find(candidate => candidate.session.id === sessionId)
    if (agent !== undefined) registerFor(agent, agentPreset)
  }, { global: true })
}
