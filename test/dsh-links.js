import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

const workspace = new URL('..', import.meta.url).pathname
// The local DeepSeek Harness checkout that provides the Host packages. Tests
// that need it are skipped when the variable is unset.
const checkout = process.env.DSH_CHECKOUT ?? ''

/**
 * Host plugins import packages that only an installed harness provides. Link
 * the local checkout into this workspace once so the integration tests can run.
 * @returns {boolean} whether the packages are resolvable afterwards.
 */
export function ensureDshLinks() {
  if (checkout === '') return false
  const links = [
    ['@deepseek-ai/dsh-tools', 'packages/core/tools'],
    ['@deepseek-ai/dsh-llm', 'packages/llm/llm'],
    ['@deepseek-ai/schemastery', 'vendor/schemastery'],
  ]
  for (const [name, relative] of links) {
    const source = join(checkout, relative)
    if (!existsSync(source)) return false
    const target = join(workspace, 'node_modules', ...name.split('/'))
    if (existsSync(target)) continue
    mkdirSync(dirname(target), { recursive: true })
    try {
      symlinkSync(source, target)
    } catch (error) {
      // Two test files may run in parallel and race to create the same link.
      if (error?.code !== 'EEXIST') throw error
    }
  }
  return true
}

export const dshAvailable = ensureDshLinks()
