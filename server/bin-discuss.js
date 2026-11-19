#!/usr/bin/env node
import { loadServerConfig } from './config-file.js'
import { resolveServerConfig } from './config.js'
import { openDatabase } from './db.js'
import { createDiscussServer } from './http.js'

const config = resolveServerConfig(loadServerConfig())
const db = openDatabase(config.dbPath)
const discuss = createDiscussServer({ db, config })

discuss.server.listen(config.port, config.host, () => {
  console.log(`dsh-discuss server listening on http://${config.host}:${config.port}`)
  console.log(`database: ${config.dbPath}`)
})

// A listen failure is fatal: say so in the log instead of leaving a pid file
// behind with a process that never served a request.
discuss.server.on('error', (error) => {
  console.error(`dsh-discuss: cannot listen on ${config.host}:${config.port}: ${String(error)}`)
  db.close()
  process.exit(1)
})

let closing = false
async function shutdown(signal) {
  if (closing) return
  closing = true
  console.log(`dsh-discuss: ${signal}, shutting down`)
  await discuss.close().catch(() => {})
  db.close()
  process.exit(0)
}

process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
