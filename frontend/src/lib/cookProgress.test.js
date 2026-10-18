import test from 'node:test'
import assert from 'node:assert/strict'
import { SESSION_MS, clearProgress, loadProgress, saveProgress } from './cookProgress.js'

function shim() {
  const data = {}
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v) },
    removeItem: (k) => { delete data[k] },
  }
}

const EMPTY = { step: 0, gathered: [], done: [] }

test('nothing saved means the start', () => {
  assert.deepEqual(loadProgress('r1', 5, shim(), 0), EMPTY)
})

test('progress comes back, and the two writers do not erase each other', () => {
  const s = shim()
  saveProgress('r1', { gathered: [0, 2], done: [1] }, s, 1000)
  saveProgress('r1', { step: 3 }, s, 2000)
  assert.deepEqual(loadProgress('r1', 5, s, 3000), { step: 3, gathered: [0, 2], done: [1] })
})

test('progress is per recipe', () => {
  const s = shim()
  saveProgress('r1', { step: 2 }, s, 0)
  assert.equal(loadProgress('r2', 5, s, 1).step, 0)
})

test('progress older than a cooking session is thrown away', () => {
  const s = shim()
  saveProgress('r1', { step: 2, done: [0] }, s, 0)
  assert.equal(loadProgress('r1', 5, s, SESSION_MS - 1).step, 2)
  assert.deepEqual(loadProgress('r1', 5, s, SESSION_MS), EMPTY)
})

test('a stale save does not leak into a fresh one', () => {
  const s = shim()
  saveProgress('r1', { done: [0, 1, 2] }, s, 0)
  saveProgress('r1', { step: 1 }, s, SESSION_MS + 5)
  assert.deepEqual(loadProgress('r1', 5, s, SESSION_MS + 6), { step: 1, gathered: [], done: [] })
})

test('a step beyond the recipe, as edited since, is clamped', () => {
  const s = shim()
  saveProgress('r1', { step: 9 }, s, 0)
  assert.equal(loadProgress('r1', 4, s, 1).step, 3)
  assert.equal(loadProgress('r1', 0, s, 1).step, 0)
})

test('garbage in storage reads as the start', () => {
  const s = shim()
  s.setItem('recipebox:cook:r1', '{nope')
  assert.deepEqual(loadProgress('r1', 5, s, 1), EMPTY)
  s.setItem('recipebox:cook:r1', JSON.stringify({ savedAt: 1, step: 'x', gathered: 'y', done: [1, -2, 'z', 1.5] }))
  assert.deepEqual(loadProgress('r1', 5, s, 2), { step: 0, gathered: [], done: [1] })
  assert.deepEqual(loadProgress('r1', 5, { getItem() { throw new Error('blocked') } }, 2), EMPTY)
})

test('clearing removes it, and a blocked store does not throw', () => {
  const s = shim()
  saveProgress('r1', { step: 2 }, s, 0)
  clearProgress('r1', s)
  assert.deepEqual(loadProgress('r1', 5, s, 1), EMPTY)
  assert.doesNotThrow(() => clearProgress('r1', { removeItem() { throw new Error('x') } }))
  assert.doesNotThrow(() => saveProgress('r1', { step: 1 }, { getItem: () => null, setItem() { throw new Error('full') } }, 0))
})
