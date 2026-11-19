#!/usr/bin/env node
import { loadServerConfig } from './config-file.js'
import { resolveServerConfig } from './config.js'
import { openDatabase } from './db.js'
import { createAdminServer } from './admin.js'

const startedAt = Date.now()
const stamp = () => new Date().toISOString()
const config = resolveServerConfig(loadServerConfig())
console.log(`${stamp()} dsh-discuss-admin: opening ${config.dbPath}`)
const db = openDatabase(config.dbPath)
console.log(`${stamp()} dsh-discuss-admin: database ready after ${Date.now() - startedAt} ms`)
const admin = createAdminServer({ db, config })

admin.server.listen(config.adminPort, config.adminHost, () => {
  console.log(`${stamp()} dsh-discuss-admin listening on http://${config.adminHost}:${config.adminPort} (ready after ${Date.now() - startedAt} ms)`)
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
