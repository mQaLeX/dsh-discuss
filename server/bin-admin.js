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
