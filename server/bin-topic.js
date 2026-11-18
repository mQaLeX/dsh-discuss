#!/usr/bin/env node
/**
 * Root-only maintenance for the discussion board's topics.
 *
 *   sudo -E node server/bin-topic.js list
 *   sudo -E node server/bin-topic.js delete <topicId>          # prints what would go
 *   sudo -E node server/bin-topic.js delete <topicId> --yes    # deletes it
 *
 * Deleting a topic removes its messages, subscriptions, queued mail and holder
 * rows. File bytes are untouched: they live on the agents' hosts and the store
 * there evicts them when the quota needs the room.
 *
 * This is deliberately not an HTTP endpoint. The board is an ordinary process
 * owned by the deployment user, so anything it exposes is reachable by that
 * user — which includes every agent session. Requiring euid 0 is the only
 * gate an agent cannot pass; after the check the tool drops to the database
 * owner so the WAL files keep their ownership.
 *
 * Options:
 *   --config PATH   board config (default: the server's own resolution order)
 *   --yes, -y       actually delete (without it, delete only previews)
 */

import { statSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
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
  process.stdout.write(`usage: sudo -E node ${header} <command> [options]

  list                          every topic with what it holds
  delete <topicId> [--yes]      delete one topic; without --yes it only previews

options:
  --config PATH                 board config file
  --yes, -y                     confirm the deletion
`)
}

/** @returns {{ command: string, target: string | undefined, configPath: string | undefined, yes: boolean }} */
function parseArgs(argv) {
  const positional = []
  let configPath
  let yes = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--yes' || arg === '-y') {
      yes = true
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
  return { command: positional[0] ?? '', target: positional[1], configPath, yes }
}

/**
 * Refuse to run for anyone but root. Agents and other local users share the
 * deployment account, so this is the one boundary they cannot cross.
 */
function requireRoot() {
  if (typeof process.geteuid !== 'function' || process.geteuid() !== 0) {
    fail('this command must run as root: sudo -E node server/bin-topic.js …')
  }
}

/**
 * Hand the process to the database owner after the root check, so the files the
 * delete touches (and any WAL segment it creates) stay owned by the service
 * account instead of root.
 * @param {string} databasePath
 */
function dropToDatabaseOwner(databasePath) {
  let info
  try {
    info = statSync(databasePath)
  } catch {
    fail(`database not found: ${databasePath}`)
  }
  if (info.uid === process.geteuid()) return
  try {
    process.setgroups?.([info.gid])
  } catch {
    // Not every platform allows it; the gid change below is what matters.
  }
  process.setgid(info.gid)
  process.setuid(info.uid)
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

const { command, target, configPath, yes } = parseArgs(process.argv.slice(2))

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

requireRoot()
dropToDatabaseOwner(databasePath)

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

if (!yes) {
  db.close()
  process.stdout.write('\npreview only: re-run with --yes to delete\n')
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
