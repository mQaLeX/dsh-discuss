import { existsSync, readFileSync } from 'node:fs'

/**
 * Read the server config JSON. `DISCUSS_CONFIG` wins, then an explicit CLI
 * path, then `./discuss.config.json` when present, then defaults.
 * @param {string[]} argv
 * @returns {Record<string, any>}
 */
export function loadServerConfig(argv = process.argv.slice(2)) {
  const explicit = process.env.DISCUSS_CONFIG ?? argv.find(arg => arg.startsWith('--config='))?.slice('--config='.length)
  const candidate = explicit ?? (existsSync('./discuss.config.json') ? './discuss.config.json' : undefined)
  if (candidate === undefined) return {}
  return JSON.parse(readFileSync(candidate, 'utf8'))
}
