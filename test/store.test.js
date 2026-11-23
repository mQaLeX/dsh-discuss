import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FileStore } from '../client/src/store.js'

function withStore(options, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discuss-store-'))
  const store = new FileStore({ dir, ...options })
  try {
    return fn(store, dir)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('putBytes is content addressed and idempotent', () => {
  withStore({}, (store) => {
    const bytes = Buffer.from('package payload')
    const first = store.putBytes(bytes)
    assert.equal(first.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(first.size, bytes.length)
    assert.ok(store.has(first.sha256))
    assert.deepEqual(readFileSync(store.pathFor(first.sha256)), bytes)
    const second = store.putBytes(bytes)
    assert.equal(second.sha256, first.sha256)
    assert.equal(store.stats().files, 1)
  })
})

test('links map a message to its blob', () => {
  withStore({}, (store) => {
    const { sha256 } = store.putBytes(Buffer.from('data'))
    store.link('ab12cd', 42, sha256)
    assert.equal(store.shaFor('ab12cd', 42), sha256)
    assert.match(store.pathForMessage('ab12cd', 42) ?? '', new RegExp(sha256))
    assert.equal(store.shaFor('ab12cd', 43), undefined)
  })
})

test('importFromFs streams in chunks and matches the sha', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discuss-store-'))
  const store = new FileStore({ dir })
  try {
    const bytes = Buffer.from('0123456789abcdef')
    const fs = {
      async readByteRange(_target, { offset, length }) {
        return bytes.subarray(offset, offset + length)
      },
    }
    const imported = await store.importFromFs(fs, 'ignored', bytes.length, { chunkSize: 4 })
    assert.equal(imported.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(imported.size, bytes.length)
    assert.deepEqual(readFileSync(store.pathFor(imported.sha256)), bytes)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('eviction drops the least recently used unlinked blob', () => {
  withStore({ maxBytes: 100 }, (store) => {
    const old = store.putBytes(Buffer.alloc(60, 1))
    const fresh = store.putBytes(Buffer.alloc(60, 2))
    assert.equal(store.stats().files, 1, 'the unlinked older blob was evicted')
    assert.ok(store.has(fresh.sha256))
    assert.equal(store.has(old.sha256), false)
  })
})

test('linked blobs are never evicted and a full store rejects new ones', () => {
  withStore({ maxBytes: 100 }, (store) => {
    const kept = store.putBytes(Buffer.alloc(60, 3))
    store.link('topic1', 1, kept.sha256)
    assert.throws(
      () => store.putBytes(Buffer.alloc(60, 4)),
      error => error.code === 'STORE_FULL',
    )
    assert.ok(store.has(kept.sha256))
  })
})

test('two stores on one directory share the database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discuss-store-'))
  const first = new FileStore({ dir })
  const second = new FileStore({ dir })
  try {
    const bytes = Buffer.from('shared')
    const a = first.putBytes(bytes)
    const b = second.putBytes(bytes)
    assert.equal(a.sha256, b.sha256)
    assert.equal(first.stats().files, 1)
    second.link('ab12cd', 7, b.sha256)
    assert.equal(first.shaFor('ab12cd', 7), b.sha256)
  } finally {
    first.close()
    second.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('adopt enforces the quota and removes the temporary file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discuss-store-'))
  const store = new FileStore({ dir, maxBytes: 10 })
  try {
    const temporary = join(store.blobDir, 'temp.bin')
    writeFileSync(temporary, Buffer.alloc(20))
    assert.throws(
      () => store.adopt(temporary, 'a'.repeat(64), 20),
      error => error.code === 'STORE_FULL',
    )
    assert.equal(existsSync(temporary), false)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('importFromFs refuses a file larger than the quota', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discuss-store-'))
  const store = new FileStore({ dir, maxBytes: 10 })
  try {
    const bytes = Buffer.alloc(20)
    const fs = {
      async readByteRange(_target, { offset, length }) {
        return bytes.subarray(offset, offset + length)
      },
    }
    await assert.rejects(
      () => store.importFromFs(fs, 'ignored', bytes.length),
      error => error.code === 'STORE_FULL',
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pathForMessage is empty once the blob is gone', () => {
  withStore({}, (store) => {
    const { sha256 } = store.putBytes(Buffer.from('gone'))
    store.link('ab12cd', 9, sha256)
    assert.ok(store.pathForMessage('ab12cd', 9))
    unlinkSync(store.pathFor(sha256))
    assert.equal(store.pathForMessage('ab12cd', 9), undefined)
  })
})
