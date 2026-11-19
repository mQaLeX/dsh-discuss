#!/usr/bin/env node
import { loadServerConfig } from './config-file.js'
import { resolveServerConfig } from './config.js'
import { openDatabase } from './db.js'
import { createAdminServer } from './admin.js'

const config = resolveServerConfig(loadServerConfig())
const db = openDatabase(config.dbPath)
const admin = createAdminServer({ db, config })

admin.server.listen(config.adminPort, config.adminHost, () => {
  console.log(`dsh-discuss-admin listening on http://${config.adminHost}:${config.adminPort}`)
  console.log(`database: ${config.dbPath}`)
})

// A listen failure is fatal: say so in the log instead of leaving a pid file
// behind with a process that never served a request.
admin.server.on('error', (error) => {
  console.error(`dsh-discuss-admin: cannot listen on ${config.adminHost}:${config.adminPort}: ${String(error)}`)
  db.close()
  process.exit(1)
})

let closing = false
async function shutdown(signal) {
  if (closing) return
  closing = true
  console.log(`dsh-discuss-admin: ${signal}, shutting down`)
  await admin.close().catch(() => {})
  db.close()
  process.exit(0)
}

process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
