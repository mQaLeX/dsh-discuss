#!/usr/bin/env node
/**
 * Regenerate the discuss/discuss-admin preset patches from the installed DSH
 * standard preset. Run after a DSH upgrade:
 *
 *   node client/scripts/build-presets.mjs /path/to/dsh/packages/bundle/web-app/presets/standard.patch.yml
 *   (or set DSH_STANDARD_PRESET)
 *
 * `--check` compares instead of writing and exits non-zero when the committed
 * patches are stale.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderPresets } from './preset-template.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const check = args.includes('--check')
const standardPath = args.find(arg => arg !== '--check') ?? process.env.DSH_STANDARD_PRESET
if (standardPath === undefined) {
  console.error('usage: node client/scripts/build-presets.mjs [--check] <standard.patch.yml>')
  process.exit(1)
}

const rendered = renderPresets(readFileSync(standardPath, 'utf8'))
const targets = {
  [join(root, 'client', 'cordis.patch.yml')]: rendered.discuss,
  [join(root, 'admin', 'cordis.patch.yml')]: rendered.admin,
}

if (check) {
  let stale = false
  for (const [path, expected] of Object.entries(targets)) {
    const actual = readFileSync(path, 'utf8')
    if (actual !== expected) {
      console.error(`stale preset patch: ${path}; re-run scripts/build-presets.mjs`)
      stale = true
    }
  }
  process.exit(stale ? 1 : 0)
}

for (const [path, content] of Object.entries(targets)) writeFileSync(path, content)
console.log('wrote cordis.patch.yml and admin/cordis.patch.yml')
