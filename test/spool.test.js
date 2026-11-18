import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Spool } from '../client/src/spool.js'

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discuss-spool-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('append, load and clear round trip', () => {
  withTemp((dir) => {
    const spool = new Spool(join(dir, 'nested', 'session.jsonl'))
    spool.append([{ mailId: 1, text: 'a' }, { mailId: 2, text: 'b' }])
    assert.deepEqual(spool.load(), [{ mailId: 1, text: 'a' }, { mailId: 2, text: 'b' }])
    spool.clear()
    assert.deepEqual(spool.load(), [])
  })
})

test('a torn trailing line is ignored, earlier lines survive', () => {
  withTemp((dir) => {
    const path = join(dir, 'torn.jsonl')
    writeFileSync(path, '{"mailId":1}\n{"mailId":2')
    const spool = new Spool(path)
    assert.deepEqual(spool.load(), [{ mailId: 1 }])
  })
})

test('load on a missing spool is empty', () => {
  withTemp((dir) => {
    assert.deepEqual(new Spool(join(dir, 'none.jsonl')).load(), [])
  })
})

test('replace rewrites the spool to exactly the given messages', () => {
  withTemp((dir) => {
    const spool = new Spool(join(dir, 'session.jsonl'))
    spool.append([{ mailId: 1 }, { mailId: 2 }])
    spool.replace([{ mailId: 2 }, { mailId: 3 }])
    assert.deepEqual(spool.load(), [{ mailId: 2 }, { mailId: 3 }])
  })
})
