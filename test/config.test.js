import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensureInstallationId } from '../client/src/config.js'

test('the first read creates installationId.json with only the id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discuss-id-'))
  try {
    const path = join(dir, 'nested', 'installationId.json')
    const first = ensureInstallationId(path)
    assert.match(first.installationId, /^[0-9a-f-]{36}$/)
    const stored = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(Object.keys(stored), ['installationId'])
    assert.equal(stored.installationId, first.installationId)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const second = ensureInstallationId(path)
    assert.equal(second.installationId, first.installationId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an existing file keeps its id and ignores any other keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discuss-id-'))
  try {
    const path = join(dir, 'installationId.json')
    writeFileSync(path, JSON.stringify({ installationId: 'fixed-id', server: 'http://old:7801' }))
    const loaded = ensureInstallationId(path)
    assert.equal(loaded.installationId, 'fixed-id')
    // The file is not rewritten; extra keys are simply not read.
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).server, 'http://old:7801')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file without an id is replaced with one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discuss-id-'))
  try {
    const path = join(dir, 'installationId.json')
    writeFileSync(path, JSON.stringify({ server: 'http://old:7801' }))
    const loaded = ensureInstallationId(path)
    assert.match(loaded.installationId, /^[0-9a-f-]{36}$/)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { installationId: loaded.installationId })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent processes agree on one installation id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discuss-id-'))
  try {
    const path = join(dir, 'installationId.json')
    const moduleUrl = new URL('../client/src/config.js', import.meta.url).href
    const script = `import { ensureInstallationId } from ${JSON.stringify(moduleUrl)};`
      + `process.stdout.write(ensureInstallationId(${JSON.stringify(path)}).installationId)`
    const outputs = Array.from({ length: 8 }, () => execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { encoding: 'utf8' },
    ).trim())
    assert.equal(new Set(outputs).size, 1, `ids diverged: ${outputs.join(', ')}`)
    assert.match(outputs[0], /^[0-9a-f-]{36}$/)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).installationId, outputs[0])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
