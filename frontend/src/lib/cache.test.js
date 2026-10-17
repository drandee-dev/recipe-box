// withMirror: the offline read mirror and, since D, its timeout.
//
// The timeout exists because a stalled request never settles, so the fallback to
// the saved copy (and the offline banner that rides on it) never ran. These tests
// use a fetch that genuinely never resolves, which is the case a rejecting stub
// cannot show.

import test from 'node:test'
import assert from 'node:assert/strict'

class MemoryStorage {
  #data = new Map()
  getItem(k) {
    return this.#data.has(k) ? this.#data.get(k) : null
  }
  setItem(k, v) {
    this.#data.set(k, String(v))
  }
  removeItem(k) {
    this.#data.delete(k)
  }
  clear() {
    this.#data.clear()
  }
  key() {
    return null
  }
  get length() {
    return this.#data.size
  }
}
globalThis.localStorage = new MemoryStorage()

const { withMirror } = await import('./cache.js')
const never = () => new Promise(() => {})

test('a fetch that never answers falls back to the saved copy, marked stale', async () => {
  localStorage.clear()
  await withMirror('k', async () => [{ id: 1 }])
  const got = await withMirror('k', never, { timeoutMs: 30 })
  assert.deepEqual(got, { rows: [{ id: 1 }], stale: true })
})

test('a stall with no saved copy is an error the screen can show', async () => {
  localStorage.clear()
  await assert.rejects(withMirror('k2', never, { timeoutMs: 30 }), /too slow/)
})

test('a prompt answer is fresh, is saved, and is not cut off by the timer', async () => {
  localStorage.clear()
  const got = await withMirror('k3', async () => [{ id: 2 }], { timeoutMs: 30 })
  assert.deepEqual(got, { rows: [{ id: 2 }], stale: false })
  await new Promise((r) => setTimeout(r, 60))
  const again = await withMirror('k3', never, { timeoutMs: 30 })
  assert.deepEqual(again.rows, [{ id: 2 }])
})

test('signed out (no key) is not timed: localStorage is the source', async () => {
  const got = await withMirror(null, async () => [{ id: 3 }], { timeoutMs: 1 })
  assert.deepEqual(got, { rows: [{ id: 3 }], stale: false })
})
