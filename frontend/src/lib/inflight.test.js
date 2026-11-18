import test from 'node:test'
import assert from 'node:assert/strict'
import { countingFetch, writesInFlight } from './inflight.js'

test('a write counts while on the wire, a read never does', async () => {
  let finish
  globalThis.fetch = () => new Promise((resolve) => (finish = resolve))
  const write = countingFetch('/x', { method: 'POST' })
  assert.equal(writesInFlight(), 1)
  finish({ ok: true })
  await write
  assert.equal(writesInFlight(), 0)

  const read = countingFetch('/x')
  assert.equal(writesInFlight(), 0)
  finish({ ok: true })
  await read
})

test('a failed write still stops counting', async () => {
  globalThis.fetch = () => Promise.reject(new Error('offline'))
  await assert.rejects(countingFetch('/x', { method: 'PATCH' }))
  assert.equal(writesInFlight(), 0)
})
