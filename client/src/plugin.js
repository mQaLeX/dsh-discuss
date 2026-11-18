import { copyFileSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { DEFAULTS } from '../../shared/constants.js'
import { DiscussError } from '../../shared/errors.js'
import { DiscussApi } from './api.js'
import { defaultInstallationPath, ensureInstallationId } from './config.js'
import { SessionClient } from './core.js'
import { HostRelay } from './host-relay.js'
import { Spool } from './spool.js'
import { defaultStoreDir, FileStore } from './store.js'
import { renderPromptText } from './prompt.js'

export const name = 'dsh-discuss'
export const inject = ['tools', 'agents', 'fs', 'systemPrompt']

/**
 * Plugin settings. Every client-facing option lives here; the per-host
 * `installationId.json` holds the identity only.
 */
export const Config = z.object({
  configPath: z.string().default('').description(
    'Override the path of the per-host installationId.json.',
  ),
  server: z.string().default('').description(
    'Board server URL, for example http://192.168.1.10:7801. Required.',
  ),
  presetId: z.string().default('discuss').description(
    'Agent preset id whose sessions get the discuss tools; empty disables the gate.',
  ),
  clientDataDir: z.string().default('').description(
    'Directory for per-session spool files; defaults to a sibling of installationId.json.',
  ),
  formRefreshSeconds: z.natural().default(DEFAULTS.formRefreshSeconds).description(
    'How often the session subscription panel refreshes.',
  ),
  coalesceMs: z.natural().default(DEFAULTS.coalesceMs).description(
    'Idle coalescing window before the first digest is injected.',
  ),
  mergeThrottleMs: z.natural().default(DEFAULTS.mergeThrottleMs).description(
    'Minimum interval between digest rewrites while one is pending.',
  ),
  digestMaxMessages: z.natural().default(DEFAULTS.digestMaxMessages).description(
    'Maximum messages rendered in one digest.',
  ),
  digestMaxChars: z.natural().default(DEFAULTS.digestMaxChars).description(
    'Maximum characters rendered in one digest.',
  ),
  bufferMaxMessages: z.natural().default(DEFAULTS.digestMaxMessages).description(
    'Maximum buffered messages before receipt trimming drops the oldest.',
  ),
  storeDir: z.string().default('').description(
    'Directory for the shared file store; defaults under $XDG_DATA_HOME/dsh-discuss.',
  ),
  storeMaxBytes: z.natural().default(DEFAULTS.storeMaxBytes).description(
    'Disk quota for imported and fetched files on this host.',
  ),
})

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true, description: 'Model-facing result.' },
  },
}

const AT_PARAM = {
  type: 'string',
  description: 'Optional username to mention (from discuss_whoami, with or without the leading @). That session must be subscribed to this topic and must not be you.',
}

/**
 * Confirm the optional @-mention in a tool result.
 * @param {unknown} at
 * @returns {string}
 */
/**
 * Human-readable file-size limit: whole MiB above 10, one decimal below so a
 * small limit stays precise.
 * @param {number} bytes
 * @returns {string}
 */
function formatMiB(bytes) {
  const mib = bytes / (1024 * 1024)
  const rounded = mib >= 10 ? Math.round(mib) : Math.round(mib * 10) / 10
  return `${rounded} MiB`
}

function mentionSuffix(at) {
  if (typeof at !== 'string') return ''
  const username = at.trim().replace(/^@+/, '').toLowerCase()
  return username.length === 0 ? '' : ` (at @${username})`
}

/**
 * @param {unknown} error
 * @returns {Error}
 */
function fail(error) {
  if (error instanceof DiscussError) return new Error(JSON.stringify(error.toBody()))
  const message = error instanceof Error ? error.message : String(error)
  return new Error(JSON.stringify({
    ok: false,
    error: { code: 'INTERNAL', message, retryable: false },
  }))
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 */
async function readBody(req, limit = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new DiscussError('CONTENT_TOO_LONG', 'request body is too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * @param {{ session: { header: { origin?: string, cwd?: string } }, status: string }} agent
 * @returns {boolean}
 */
function isSubagent(agent) {
  return agent?.session?.header?.origin === 'subagent'
}

/**
 * Whether the Workspace registry currently lists this session as archived.
 * @param {any} agent
 * @returns {boolean}
 */
function sessionArchived(ctx, agent) {
  const registry = ctx.get('workspaceRegistry')
  return registry?.archivedSessionIds?.includes(agent.session.id) === true
}

/**
 * Resolve a model-supplied save path inside the session workspace. The fs seam
 * has no binary write, so writes re-check containment here and then use the
 * host filesystem; reads always go through `ctx.fs`.
 * @param {any} agent
 * @param {string} savePath
 * @returns {string}
 */
function resolveWriteTarget(agent, savePath) {
  const cwd = resolve(agent.session.header.cwd ?? process.cwd())
  const absolute = isAbsolute(savePath) ? resolve(savePath) : resolve(cwd, savePath)
  const rel = relative(cwd, absolute)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    throw new DiscussError('PATH_NOT_ALLOWED', `path is outside the session workspace: ${savePath}`, {
      details: { workspace: cwd },
    })
  }
  return absolute
}

/**
 * @param {string} path
 * @param {string | Uint8Array} data
 */
function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, data)
  renameSync(temporary, path)
}

/**
 * @param {any} ctx
 * @param {Record<string, any>} [config]
 */
export function apply(ctx, config = {}) {
  const settings = {
    configPath: '',
    server: '',
    clientDataDir: '',
    coalesceMs: DEFAULTS.coalesceMs,
    mergeThrottleMs: DEFAULTS.mergeThrottleMs,
    digestMaxMessages: DEFAULTS.digestMaxMessages,
    digestMaxChars: DEFAULTS.digestMaxChars,
    bufferMaxMessages: DEFAULTS.digestMaxMessages,
    formRefreshSeconds: DEFAULTS.formRefreshSeconds,
    storeDir: '',
    storeMaxBytes: DEFAULTS.storeMaxBytes,
    presetId: 'discuss',
    ...config,
  }
  const logger = ctx.logger ?? console

  let installation
  try {
    installation = ensureInstallationId(settings.configPath || defaultInstallationPath())
  } catch (error) {
    logger.error?.(`dsh-discuss: cannot read or create the installation id file: ${String(error)}`)
    return
  }
  const baseUrl = settings.server
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    logger.error?.('dsh-discuss: no server address in the plugin config; plugin disabled')
    return
  }

  const api = new DiscussApi({ baseUrl, logger })
  const spoolRoot = settings.clientDataDir || join(dirname(installation.path), 'spool')
  const store = new FileStore({
    dir: settings.storeDir || defaultStoreDir(),
    maxBytes: settings.storeMaxBytes,
    logger,
  })
  const relay = new HostRelay({
    api,
    installationId: installation.installationId,
    store,
    logger,
  })
  relay.start()
  /** @type {Map<string, SessionClient>} */
  const sessions = new Map()
  /** @type {Map<string, Array<() => void>>} */
  const toolDisposers = new Map()

  /**
   * @param {any} exec
   * @returns {{ client: SessionClient, agent: any }}
   */
  function contextOf(exec) {
    const agent = exec?.agent
    if (agent === undefined) throw new DiscussError('INTERNAL', 'discuss tools need an owning agent session')
    const client = sessions.get(agent.session.id)
    if (client === undefined) {
      throw new DiscussError('SUBAGENT_FORBIDDEN', 'this session has no discuss client')
    }
    return { client, agent }
  }

  /**
   * @param {string} toolName
   * @param {string} description
   * @param {Record<string, any>} parameters
   * @param {(args: any, exec: any) => Promise<string>} run
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
      async execute(args, exec) {
        try {
          return { text: await run(args, exec) }
        } catch (error) {
          throw fail(error)
        }
      },
    })
  }

  /**
   * Stream one local file into the shared store.
   * @param {any} exec
   * @param {string} sourcePath
   * @returns {Promise<{ sha256: string, size: number }>}
   */
  async function importSource(exec, sourcePath) {
    const cwd = exec.agent?.session?.header?.cwd ?? process.cwd()
    const target = await ctx.fs.resolve(sourcePath, { cwd, signal: exec.signal })
    const info = await ctx.fs.stat(target, exec.signal)
    if (info === undefined) throw new DiscussError('FILE_NOT_FOUND', `no such file: ${sourcePath}`)
    const size = info.size ?? 0
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new DiscussError('CONTENT_EMPTY', 'cannot share an empty file')
    }
    if (size > settings.storeMaxBytes) {
      throw new DiscussError('FILE_TOO_LARGE', `file exceeds the ${settings.storeMaxBytes}-byte store quota`, {
        details: { max: settings.storeMaxBytes, actual: size },
      })
    }
    return store.importFromFs(ctx.fs, target, size, { signal: exec.signal })
  }

  /**
   * Register the eleven discuss tools on one agent's scope, so subagent sessions
   * never see them at all.
   * @param {any} agent
   */
  function registerTools(agent) {
    const tools = agent.ctx.tools
    const toolList = [
      tool('discuss_whoami',
        'Return this session\'s username on the discussion board and the limits the board enforces.',
        {},
        async (_args, exec) => {
          const { client } = contextOf(exec)
          const state = await client.ensureRegistered()
          const limits = state.limits ?? client.limits ?? {}
          const parts = []
          if (typeof limits.contentMax === 'number') parts.push(`${limits.contentMax} characters per message`)
          if (typeof limits.ratePerMinute === 'number') parts.push(`${limits.ratePerMinute} writes per minute`)
          if (typeof limits.fileMaxBytes === 'number') parts.push(`files up to ${formatMiB(limits.fileMaxBytes)}`)
          const suffix = parts.length === 0 ? '' : `\nLimits: ${parts.join(', ')}.`
          return `You are @${state.username} on the board.${suffix}`
        }),

      tool('discuss_list_topics',
        'List the topics this session is subscribed to.',
        {},
        async (_args, exec) => {
          const { client } = contextOf(exec)
          const topics = await client.topics()
          if (topics.subscribed.length === 0) {
            return 'No subscribed topics. The human enables them in this session\'s panel; you cannot subscribe yourself.'
          }
          return ['Subscribed topics:', ...topics.subscribed.map(topic => `- ${topic.id}  ${topic.name}`)].join('\n')
        }),

      tool('discuss_refresh',
        'Pull the discussion messages that arrived since the last digest. Call it at checkpoints — before finishing a piece of work, after a long tool call, or while waiting on a teammate — not on every step. Pulled messages are not injected again.',
        {},
        async (_args, exec) => {
          const { client } = contextOf(exec)
          const pulled = client.refresh()
          return pulled === null ? 'No new messages.' : pulled.text
        }),

      tool('discuss_unsubscribe',
        'Stop receiving one topic. Only the human can re-enable it afterwards.',
        {
          topicId: { type: 'string', required: true, description: 'Topic id from discuss_list_topics.' },
        },
        async (args, exec) => {
          const { client } = contextOf(exec)
          await client.unsubscribe(args.topicId)
          return `Unsubscribed from ${args.topicId}. Only the human can re-enable it.`
        }),

      tool('discuss_post',
        'Publish a new message in one topic this session subscribes to. An optional at username notifies that session (it must be subscribed to the topic).',
        {
          topicId: { type: 'string', required: true, description: 'Topic id from discuss_list_topics.' },
          content: { type: 'string', required: true, description: 'Message body; keep it short and attach details as a file instead.' },
          at: AT_PARAM,
        },
        async (args, exec) => {
          const { client } = contextOf(exec)
          const id = await client.post(args.topicId, args.content, args.at)
          return `Posted ${args.topicId}/${id}.${mentionSuffix(args.at)}`
        }),

      tool('discuss_comment',
        'Reply to an existing post or comment. One comment per message per session; a repeat returns the existing id. An optional at username notifies that session (it must be subscribed to the topic).',
        {
          topicId: { type: 'string', required: true, description: 'Topic id that contains the parent message.' },
          content: { type: 'string', required: true, description: 'Reply body; keep it short and attach details as a file instead.' },
          messageId: { type: 'integer', required: true, description: 'Id of the post or comment being answered.' },
          at: AT_PARAM,
        },
        async (args, exec) => {
          const { client } = contextOf(exec)
          const id = await client.comment(args.topicId, args.content, args.messageId, args.at)
          return `Commented ${args.topicId}/${id} on ${args.messageId}.${mentionSuffix(args.at)}`
        }),

      tool('discuss_share_file',
        'Copy a local file into this host\'s shared store and announce it in a topic. The board records size and sha256; the bytes stay on this host and others can fetch them only while this host is online.',
        {
          topicId: { type: 'string', required: true, description: 'Topic id from discuss_list_topics.' },
          sourcePath: { type: 'string', required: true, description: 'Local file to share; relative paths resolve against the session workspace.' },
          intro: { type: 'string', required: true, description: 'Short description shown to readers.' },
          at: AT_PARAM,
        },
        async (args, exec) => {
          const { client } = contextOf(exec)
          const stored = await importSource(exec, args.sourcePath)
          const shared = await client.shareFile(
            args.topicId, args.intro, stored.sha256, stored.size, undefined, args.at,
          )
          store.link(args.topicId, shared.id, stored.sha256)
          if (shared.duplicate) {
            return `Already shared ${args.topicId}/${shared.id} (${stored.size} bytes, sha256 ${stored.sha256}); no new message was created.`
          }
          return `Shared ${args.topicId}/${shared.id} (${stored.size} bytes, sha256 ${stored.sha256}).${mentionSuffix(args.at)} Bytes stay on this host; fetching works only while it is online.`
        }),

      tool('discuss_share_comment',
        'Copy a local file into this host\'s shared store and announce it as a reply to an existing post or comment. A file reply is a comment: if this session already replied to that message the board answers COMMENT_EXISTS and the file is not attached — reply to that earlier comment or share a new post instead.',
        {
          topicId: { type: 'string', required: true, description: 'Topic id that contains the parent message.' },
          sourcePath: { type: 'string', required: true, description: 'Local file to share; relative paths resolve against the session workspace.' },
          intro: { type: 'string', required: true, description: 'Short description shown to readers.' },
          messageId: { type: 'integer', required: true, description: 'Id of the post or comment being answered.' },
          at: AT_PARAM,
        },
        async (args, exec) => {
          const { client } = contextOf(exec)
          const stored = await importSource(exec, args.sourcePath)
          try {
            const shared = await client.shareFile(
              args.topicId, args.intro, stored.sha256, stored.size, args.messageId, args.at,
            )
            store.link(args.topicId, shared.id, stored.sha256)
            if (shared.duplicate) {
              return `Already shared ${args.topicId}/${shared.id} as a reply to ${args.messageId} (${stored.size} bytes); no new message was created.`
            }
            return `Shared ${args.topicId}/${shared.id} as a reply to ${args.messageId} (${stored.size} bytes).${mentionSuffix(args.at)}`
          } catch (error) {
            if (error instanceof DiscussError && error.code === 'COMMENT_EXISTS') {
              const details = error.details !== null && typeof error.details === 'object' ? error.details : {}
              const existing = typeof details.existingId === 'number' ? details.existingId : undefined
              const hint = existing === undefined
                ? 'share the file as a new post or as a reply to another message'
                : `share the file as a reply to your earlier reply ${args.topicId}/${existing}, or as a new post`
              throw new DiscussError(
                'COMMENT_EXISTS',
                `this session already replied to ${args.topicId}/${args.messageId}; the file was not attached — ${hint}.`,
                { details: error.details },
              )
            }
            throw error
          }
        }),

      tool('discuss_request_file',
        'Ask the board to relay one message\'s file from an online holder. The copy is verified, saved to savePath, kept in this host\'s store, and this host becomes an additional holder.',
        {
          topicId: { type: 'string', required: true, description: 'Topic id that contains the message.' },
          messageId: { type: 'integer', required: true, description: 'Id of the message that carries the file.' },
          savePath: { type: 'string', required: true, description: 'Destination inside the session workspace.' },
        },
        async (args, exec) => {
          const { client, agent } = contextOf(exec)
          await client.ensureRegistered()

          // Same-host fast path: the blob is already in this host's store
          // (this host shared it or fetched it earlier), so skip the relay.
          const localSha = store.shaFor(args.topicId, args.messageId)
          const localPath = localSha === undefined
            ? undefined
            : store.pathForMessage(args.topicId, args.messageId)
          if (localSha !== undefined && localPath !== undefined) {
            const size = store.sizeOf(localSha) ?? statSync(localPath).size
            const target = resolveWriteTarget(agent, args.savePath)
            mkdirSync(dirname(target), { recursive: true })
            copyFileSync(localPath, target)
            return `Saved ${size} bytes to ${target} (sha256 ${localSha}); served from this host's local store.`
          }

          const temporary = join(
            store.blobDir,
            `.fetch-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          )
          const fetched = await client.api.requestFile(
            client.ids, args.topicId, args.messageId, temporary, exec.signal,
          )
          const stored = store.adopt(temporary, fetched.sha256, fetched.size)
          store.link(args.topicId, args.messageId, stored.sha256)
          let note = ''
          try {
            await client.addHolder(args.topicId, args.messageId)
          } catch (error) {
            note = ` (holder registration failed: ${error instanceof Error ? error.message : String(error)})`
          }
          const target = resolveWriteTarget(agent, args.savePath)
          mkdirSync(dirname(target), { recursive: true })
          copyFileSync(store.pathFor(stored.sha256), target)
          return `Saved ${stored.size} bytes to ${target} (sha256 ${stored.sha256}); this host is now a holder.${note}`
        }),

      tool('discuss_history',
        'Export every post and comment of one topic (the whole forest) to a local JSONL file.',
        {
          topicId: { type: 'string', required: true, description: 'Topic id from discuss_list_topics.' },
          savePath: { type: 'string', required: true, description: 'Destination inside the session workspace.' },
        },
        async (args, exec) => {
          const { client, agent } = contextOf(exec)
          const text = await client.api.ndjson(client.ids, `/v1/history/${encodeURIComponent(args.topicId)}`)
          const target = resolveWriteTarget(agent, args.savePath)
          writeAtomic(target, text)
          return `Exported ${countLines(text)} messages to ${target}.`
        }),

      tool('discuss_query',
        'Export the whole thread containing one message (its root post and every reply) to a local JSONL file.',
        {
          topicId: { type: 'string', required: true, description: 'Topic id that contains the message.' },
          messageId: { type: 'integer', required: true, description: 'Any post or comment in the thread.' },
          savePath: { type: 'string', required: true, description: 'Destination inside the session workspace.' },
        },
        async (args, exec) => {
          const { client, agent } = contextOf(exec)
          const text = await client.api.ndjson(
            client.ids,
            `/v1/query/${encodeURIComponent(args.topicId)}/${args.messageId}`,
          )
          const target = resolveWriteTarget(agent, args.savePath)
          writeAtomic(target, text)
          return `Exported ${countLines(text)} messages to ${target}.`
        }),
    ]
    const disposers = []
    for (const definition of toolList) disposers.push(tools.register(definition))
    toolDisposers.set(agent.session.id, disposers)
  }

  /**
   * The live preset of an agent. The session header records the preset the
   * session *started* with and is deep-frozen; a preset switch only appends an
   * `agent-preset/selected` event. Read the recorded/projected preset first,
   * then the live composition, and fall back to the header only when neither
   * exists (preset-free deployments).
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
    const client = sessions.get(sessionId)
    if (client !== undefined) {
      sessions.delete(sessionId)
      void client.close()
    }
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
  function attach(agent, presetOverride) {
    if (isSubagent(agent)) return
    const preset = presetOverride ?? presetOf(agent)
    if (settings.presetId !== '' && preset !== undefined && preset !== settings.presetId) return
    const sessionId = agent.session.id
    if (sessions.has(sessionId)) return
    const spool = new Spool(join(spoolRoot, `${sessionId}.jsonl`))
    const client = new SessionClient({
      ids: { installationId: installation.installationId, sessionId },
      agent: {
        get status() {
          return agent.status
        },
        inject: message => agent.inject(message),
        // Older hosts have no followup(); the client then falls back to plain
        // context instead of waking a turn.
        ...(typeof agent.followup === 'function'
          ? { followup: message => agent.followup(message) }
          : {}),
        inbox: { remove: messageId => agent.inbox.remove(messageId) },
      },
      api,
      spool,
      makeMessage: (text, count) => createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'dsh-discuss',
          form: 'notice',
          summary: `${count} new message${count === 1 ? '' : 's'}`,
        },
      }),
      config: settings,
      logger,
    })
    if (agent.ctx?.tools === undefined) {
      logger.warn('dsh-discuss: agent scope has no tool registry; discuss tools are unavailable')
      return
    }
    sessions.set(sessionId, client)
    registerTools(agent)
    if (sessionArchived(ctx, agent)) void client.pause()
    client.start()
  }

  for (const agent of ctx.agents.list()) attach(agent)

  ctx.on('agent/created', ({ agent }) => attach(agent), { global: true })
  ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
    if (settings.presetId !== '' && agentPreset !== settings.presetId) {
      detach(sessionId)
      return
    }
    const agent = ctx.agents.list().find(candidate => candidate.session.id === sessionId)
    if (agent !== undefined) attach(agent, agentPreset)
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => detach(agent.session.id), { global: true })
  ctx.on('agent/status', ({ agent, status }) => {
    sessions.get(agent.session.id)?.onStatus(status)
  }, { global: true })
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    sessions.get(agent.session.id)?.onClaimed(message.id)
  }, { global: true })

  ctx.on('workspace/session-archived', ({ sessionId }) => {
    const client = sessions.get(sessionId)
    if (client !== undefined) void client.pause()
  })
  ctx.on('workspace/session-unarchiving', ({ sessionId }) => {
    const client = sessions.get(sessionId)
    if (client !== undefined) client.resume()
  })
  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    sessions.get(agent.session.id)?.onDiscarded(message.id)
  }, { global: true })

  // One ownership point for every session client, so a plugin reload closes
  // each SSE stream and unregisters each mailbox.
  ctx.effect(() => () => {
    for (const client of sessions.values()) void client.close()
    sessions.clear()
    relay.close()
    store.close()
  }, 'dsh-discuss: session clients')

  ctx.systemPrompt.section({
    name: 'dsh-discuss',
    order: 60,
    text: (assembly) => {
      const agent = assembly?.agent
      if (agent === undefined) return ''
      const client = sessions.get(agent.session.id)
      if (client === undefined) return ''
      // On-demand: a session with no subscriptions pays no prompt tokens. The
      // cache is primed right after registration and refreshed by topics().
      if (client.subscriptionsKnown && client.subscribedCount === 0) return ''
      return renderPromptText({ username: client.username, limits: client.limits })
    },
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/discuss/api',
      auth: 'required',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://dsh.invalid')
        try {
          if (url.pathname === '/discuss/api/state' && req.method === 'GET') {
            const sessionId = url.searchParams.get('sessionId') ?? ''
            const client = sessions.get(sessionId)
            if (client === undefined) {
              // A discuss-preset session exists for a moment before its board
              // client does: the preset switch re-mounts the composition, and
              // the attach that registers the client lands just after. Answer
              // `pending` instead of 404 so the panel shows a connecting state
              // and polls quickly, rather than staying blank until the next
              // slow refresh tick.
              const agent = ctx.agents.list().find(candidate => candidate.session.id === sessionId)
              const pending = agent !== undefined
                && (settings.presetId === '' || presetOf(agent) === settings.presetId)
              if (pending) {
                sendJson(res, 200, { ok: true, pending: true, refreshSeconds: settings.formRefreshSeconds })
                return
              }
              sendJson(res, 404, { ok: false, error: { code: 'MESSAGE_NOT_FOUND', message: 'unknown session', retryable: false } })
              return
            }
            const topics = await client.topics()
            sendJson(res, 200, {
              ok: true,
              username: client.username ?? null,
              connected: client.connected,
              topics: topics.all,
              backlog: client.backlog(),
              limits: client.limits,
              refreshSeconds: settings.formRefreshSeconds,
            })
            return
          }
          if (url.pathname === '/discuss/api/subscription' && req.method === 'POST') {
            const body = await readBody(req)
            const client = sessions.get(body.sessionId)
            if (client === undefined) {
              sendJson(res, 404, { ok: false, error: { code: 'MESSAGE_NOT_FOUND', message: 'unknown session', retryable: false } })
              return
            }
            if (typeof body.topicId !== 'string' || typeof body.subscribed !== 'boolean') {
              sendJson(res, 400, { ok: false, error: { code: 'CONTENT_EMPTY', message: 'topicId and subscribed are required', retryable: false } })
              return
            }
            await client.setSubscription(body.topicId, body.subscribed)
            sendJson(res, 200, { ok: true })
            return
          }
          sendJson(res, 404, { ok: false, error: { code: 'TOPIC_NOT_FOUND', message: `no route for ${url.pathname}`, retryable: false } })
        } catch (error) {
          const body = error instanceof DiscussError
            ? error.toBody()
            : { ok: false, error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error), retryable: false } }
          sendJson(res, 500, body)
        }
      },
    }), 'dsh-discuss: form routes')
  })
}

/**
 * @param {string} text
 * @returns {number}
 */
function countLines(text) {
  const trimmed = text.trim()
  return trimmed.length === 0 ? 0 : trimmed.split('\n').length
}
