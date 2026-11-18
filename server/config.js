/**
 * Server configuration: defaults from the shared constants, overridden by the
 * deployment's JSON config file and environment.
 * @param {Record<string, unknown>} [input]
 * @returns {Record<string, any>}
 */
export function resolveServerConfig(input = {}) {
  const config = {
    host: '0.0.0.0',
    port: 7801,
    adminHost: '0.0.0.0',
    adminPort: 7802,
    dbPath: './data/discuss.db',
    ...input,
  }
  return config
}
