#!/usr/bin/env node
/**
 * Maintenance for the discussion board's topics, run as the deployment user.
 *
 *   node server/bin-topic.js list
 *   node server/bin-topic.js delete <topicId>          # asks twice, then deletes
 *
 * Deleting a topic removes its messages, subscriptions, queued mail and holder
 * rows. File bytes are untouched: they live on the agents' hosts and the store
 * there evicts them when the quota needs the room.
 *
 * This is deliberately not an HTTP endpoint. The board is an ordinary process
 * owned by the deployment user, so anything it exposes is reachable by that
 * user; a command that only runs as the database owner stays a local operator
 * action on the board host instead. Agents on that machine run as a different
 * user, so the CLI is out of their reach — keep it that way if the board host
 * ever also runs agent sessions.
 *
 * Options:
 *   --config PATH   board config (default: the server's own resolution order)
 *
 * `delete` asks for two `y` answers on the terminal before it touches anything:
 * the first after the census, the second as the final confirmation. Without
 * them the command exits 2 and deletes nothing.
 */

import { statSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { loadServerConfig } from './config-file.js'
import { resolveServerConfig } from './config.js'
import { openDatabase } from './db.js'
import { deleteTopic, topicCensus } from './store.js'

function fail(message, code = 1) {
  process.stderr.write(`bin-topic: ${message}\n`)
  process.exit(code)
}

function usage() {
  const header = process.argv[1] === undefined ? 'bin-topic' : 'server/bin-topic.js'
  process.stdout.write(`usage: node ${header} <command> [options]

  list                    every topic with what it holds
  delete <topicId>        delete one topic; asks for two y answers first

options:
  --config PATH           board config file
`)
}

/** @returns {{ command: string, target: string | undefined, configPath: string | undefined }} */
function parseArgs(argv) {
  const positional = []
  let configPath
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--yes' || arg === '-y') {
      fail('--yes is gone: delete asks for two y answers on the terminal', 2)
    } else if (arg === '--config') {
      const value = argv[index + 1]
      if (value === undefined) fail('--config needs a path', 2)
      configPath = value
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    } else if (arg.startsWith('-')) {
      fail(`unknown option: ${arg}`, 2)
    } else {
      positional.push(arg)
    }
  }
  return { command: positional[0] ?? '', target: positional[1], configPath }
}

/**
 * Deletion is a local operator action: it must run as the user that owns the
 * database, which on a deployment is the board's service account. That needs no
 * root on the host, keeps any WAL segment it touches under the same owner, and
 * still leaves the CLI out of reach of agent sessions, which run as another
 * user on that machine.
 * @param {string} databasePath
 */
function requireDatabaseOwner(databasePath) {
  let info
  try {
    info = statSync(databasePath)
  } catch {
    fail(`database not found: ${databasePath}`)
  }
  const euid = typeof process.geteuid === 'function' ? process.geteuid() : -1
  if (euid !== info.uid) {
    fail(`this command must run as the database owner (uid ${info.uid}): `
      + 'run it as the deployment user, for example '
      + 'sudo -u <deployment user> node server/bin-topic.js …')
  }
}

/** @param {string} databasePath @param {Record<string, any>} entry */
function audit(databasePath, entry) {
  try {
    const logDir = join(dirname(databasePath), '..', 'logs')
    mkdirSync(logDir, { recursive: true })
    appendFileSync(join(logDir, 'topic-admin.log'), `${JSON.stringify(entry)}\n`)
  } catch {
    // The audit trail is best-effort; the deletion result is what matters.
  }
}

/**
 * Resolve the board config exactly like the server does, then make its database
 * path absolute so a relative path cannot resolve against the caller's cwd.
 * @param {string | undefined} configPath
 */
function openBoard(configPath) {
  // Same file the deployment uses: <checkout>/server/discuss.config.json, or an
  // explicit --config, or whatever the server's own resolution finds.
  const deployConfig = join(dirname(fileURLToPath(import.meta.url)), 'discuss.config.json')
  const chosen = configPath ?? (existsSync(deployConfig) ? deployConfig : undefined)
  const raw = loadServerConfig(chosen === undefined ? [] : [`--config=${chosen}`])
  const config = resolveServerConfig(raw)
  const base = chosen === undefined ? process.cwd() : dirname(resolve(chosen))
  const databasePath = isAbsolute(config.dbPath) ? config.dbPath : resolve(base, config.dbPath)
  return { config, databasePath }
}

/**
 * Line-by-line stdin with prompts on stdout. One reader serves every question:
 * a fresh readline interface per question loses piped input in Node.
 * @param {NodeJS.ReadStream} input
 */
function lineReader(input) {
  const rl = createInterface({ input, terminal: Boolean(input.isTTY) })
  const queued = []
  const waiting = []
  let ended = false
  rl.on('line', (line) => {
    const resume = waiting.shift()
    if (resume === undefined) queued.push(line)
    else resume(line)
  })
  rl.on('close', () => {
    ended = true
    for (const resume of waiting.splice(0)) resume(null)
  })
  return {
    next() {
      if (queued.length > 0) return Promise.resolve(queued.shift())
      if (ended) return Promise.resolve(null)
      return new Promise((resolve) => { waiting.push(resolve) })
    },
    close() { rl.close() },
  }
}

/**
 * Two separate hand-typed confirmations: a `y` after the census, then another
 * `y` on its own prompt. Anything else, including end of input, cancels.
 * @param {{ id: string, name: string, messages: number, subscriptions: number, mailbox: number }} census
 */
async function confirmDelete(census) {
  const lines = lineReader(process.stdin)
  try {
    process.stdout.write(`Delete topic ${census.id} "${census.name}" with ${census.messages} messages, `
      + `${census.subscriptions} subscriptions and ${census.mailbox} queued mail rows? [y/N] `)
    const first = await lines.next()
    if (first === null || first.trim().toLowerCase() !== 'y') return false
    process.stdout.write(`Type y again to delete ${census.id} permanently: `)
    const second = await lines.next()
    return second !== null && second.trim().toLowerCase() === 'y'
  } finally {
    lines.close()
  }
}

const { command, target, configPath } = parseArgs(process.argv.slice(2))

if (command === '') {
  usage()
  process.exit(2)
}

const { databasePath } = openBoard(configPath)

try {
  statSync(databasePath)
} catch {
  fail(`database not found: ${databasePath}`)
}

if (command === 'list') {
  const db = openDatabase(databasePath)
  const rows = db.prepare('SELECT id, name, created_at FROM topics ORDER BY rowid').all()
  if (rows.length === 0) {
    process.stdout.write('no topics\n')
    process.exit(0)
  }
  for (const row of rows) {
    const census = topicCensus(db, row.id)
    process.stdout.write(
      `${row.id}  ${row.name.padEnd(24)} messages=${String(census.messages).padStart(4)}`
      + ` subs=${String(census.subscriptions).padStart(3)} mail=${String(census.mailbox).padStart(3)}`
      + ` holders=${String(census.holders).padStart(2)}\n`,
    )
  }
  process.exit(0)
}

if (command !== 'delete') fail(`unknown command: ${command}`, 2)
if (target === undefined) fail('delete needs a topic id', 2)

requireDatabaseOwner(databasePath)

const db = openDatabase(databasePath)
let census
try {
  census = topicCensus(db, target)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

process.stdout.write(
  `topic ${census.id} "${census.name}"\n`
  + `  messages       ${census.messages}\n`
  + `  subscriptions  ${census.subscriptions}\n`
  + `  queued mail    ${census.mailbox}\n`
  + `  holder rows    ${census.holders}\n`,
)

if (!(await confirmDelete(census))) {
  db.close()
  process.stdout.write('\nnot confirmed: nothing was deleted\n')
  process.exit(2)
}

const removed = deleteTopic(db, target)
db.close()

audit(databasePath, {
  at: new Date().toISOString(),
  uid: process.getuid?.() ?? -1,
  action: 'delete-topic',
  topic: removed.id,
  name: removed.name,
  removed,
})
process.stdout.write(`deleted ${removed.id}\n`)
