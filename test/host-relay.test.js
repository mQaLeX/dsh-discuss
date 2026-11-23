import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HostRelay } from '../client/src/host-relay.js'

test('host relay answers file probes with presence and size checks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
  const payload = Buffer.from('probe bytes')
  const sha = createHash('sha256').update(payload).digest('hex')
  const blob = join(dir, 'blob')
  writeFileSync(blob, payload)

  const calls = []
  let onFrame
  const api = {
    hostStream: (_installationId, options) => new Promise((resolve) => {
      onFrame = options.onFrame
      options.signal.addEventListener('abort', resolve, { once: true })
    }),
    hostProbe: async (...args) => { calls.push(args) },
  }
  const relay = new HostRelay({
    api,
    installationId: 'probe-host',
    store: { pathFor: value => (value === sha ? blob : undefined) },
    logger: { warn: () => {} },
  })

  const until = async (predicate) => {
    for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  try {
    relay.start()
    await until(() => onFrame !== undefined)

    onFrame({ type: 'probe', probeId: 'p1', sha256: sha, size: payload.length })
    await until(() => calls.length === 1)
    assert.deepEqual(calls[0], ['p1', 'probe-host', { ok: true }])

    onFrame({ type: 'probe', probeId: 'p2', sha256: sha, size: payload.length + 1 })
    await until(() => calls.length === 2)
    assert.deepEqual(calls[1], ['p2', 'probe-host', { ok: false, code: 'HASH_MISMATCH' }])

    onFrame({ type: 'probe', probeId: 'p3', sha256: 'a'.repeat(64), size: 1 })
    await until(() => calls.length === 3)
    assert.deepEqual(calls[2], ['p3', 'probe-host', { ok: false, code: 'FILE_NOT_FOUND' }])
  } finally {
    relay.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
