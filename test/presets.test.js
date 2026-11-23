import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { renderPresets } from '../client/scripts/preset-template.mjs'

const discuss = readFileSync(new URL('../client/cordis.patch.yml', import.meta.url), 'utf8')
const admin = readFileSync(new URL('../admin/cordis.patch.yml', import.meta.url), 'utf8')

const checkout = process.env.DSH_CHECKOUT ?? ''
const standardPath = checkout === ''
  ? undefined
  : join(checkout, 'packages/bundle/web-app/presets/standard.patch.yml')
const standardSkip = standardPath !== undefined && existsSync(standardPath)
  ? false
  : 'set DSH_CHECKOUT to the DSH checkout to compare the preset projection'

test('each bundle inserts its Host plugin row and a mode preset', () => {
  assert.match(discuss, /    - id: dsh-discuss\n      name: '@local\/dsh-discuss'\n      config: \{\}/)
  assert.match(discuss, /    - id: preset-discuss\n/)
  assert.match(discuss, /        id: discuss\n/)
  assert.doesNotMatch(discuss, /dsh-discuss-admin/)

  assert.match(admin, /    - id: dsh-discuss-admin\n      name: '@local\/dsh-discuss-admin'\n      config: \{\}/)
  assert.match(admin, /    - id: preset-discuss-admin\n/)
  assert.match(admin, /        id: discuss-admin\n/)
  assert.doesNotMatch(admin, /name: '@local\/dsh-discuss'\n/)
})

test('the presets carry the standard tool set, not the mode plugins', () => {
  for (const text of [discuss, admin]) {
    assert.match(text, /@deepseek-ai\/dsh-tool-bash/)
    assert.match(text, /@deepseek-ai\/dsh-tool-fs/)
    assert.match(text, /@deepseek-ai\/dsh-tool-subagent/)
    assert.match(text, /@deepseek-ai\/dsh-tool-workflow/)
    assert.match(text, /@deepseek-ai\/dsh-plugin-manager\/tools/)
    // Only the Host row names the local package; the preset list must not.
    assert.equal((text.match(/name: '@local\/dsh-discuss'\n/g) ?? []).length, text === discuss ? 1 : 0)
    assert.equal((text.match(/name: '@local\/dsh-discuss-admin'\n/g) ?? []).length, text === admin ? 1 : 0)
  }
})

test('the persona distinguishes the two modes', () => {
  assert.match(discuss, /You are a coding agent that also participates in the LAN discussion board\./)
  assert.match(admin, /You administer the LAN discussion board\./)
})

test('the dsh-doc skill directory resolves from the CLI entry', () => {
  for (const text of [discuss, admin]) {
    assert.match(text, /createRequire\(process\.argv\[1\] \?\? process\.cwd\(\)\)/)
    assert.doesNotMatch(text, /createRequire\(baseUrl\)/)
    assert.doesNotMatch(text, /DSH_INSTALL_DIR/)
  }
})

test('the committed patches match a fresh render of the installed standard preset', { skip: standardSkip }, () => {
  const expected = renderPresets(readFileSync(standardPath, 'utf8'))
  assert.equal(discuss, expected.discuss, 're-run client/scripts/build-presets.mjs')
  assert.equal(admin, expected.admin, 're-run client/scripts/build-presets.mjs')
})
