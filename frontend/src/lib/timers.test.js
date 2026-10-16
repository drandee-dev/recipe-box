import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SECONDS, MAX_TIMERS, isDue, loadTimers, makeTimer, manualSeconds, saveTimers, secondsLeft, sortTimers } from './timers.js'

function shim(initial = {}) {
  const data = { ...initial }
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v) },
    removeItem: (k) => { delete data[k] },
    data,
  }
}

test('a timer counts to a wall-clock instant', () => {
  const t = makeTimer({ label: '10 minutes', seconds: 600 }, 1_000_000)
  assert.equal(t.endsAt, 1_000_000 + 600_000)
  assert.equal(secondsLeft(t, 1_000_000), 600)
  assert.equal(secondsLeft(t, 1_000_000 + 599_400), 1)
  assert.equal(isDue(t, 1_000_000 + 599_999), false)
  assert.equal(isDue(t, 1_000_000 + 600_000), true)
})

test('a timer left in the background still owes the right time', () => {
  // The phone was locked for 7 minutes; nothing ticked. The next read is right.
  const t = makeTimer({ label: 'x', seconds: 600 }, 0)
  assert.equal(secondsLeft(t, 7 * 60_000), 180)
  assert.equal(secondsLeft(t, 99 * 60_000), 0)
})

test('ids differ for timers made in the same millisecond', () => {
  const a = makeTimer({ label: 'a', seconds: 60 }, 5)
  const b = makeTimer({ label: 'b', seconds: 60 }, 5)
  assert.notEqual(a.id, b.id)
})

test('sortTimers puts the soonest first and does not mutate', () => {
  const a = makeTimer({ label: 'late', seconds: 900 }, 0)
  const b = makeTimer({ label: 'soon', seconds: 60 }, 0)
  const input = [a, b]
  assert.deepEqual(sortTimers(input).map((t) => t.label), ['soon', 'late'])
  assert.deepEqual(input.map((t) => t.label), ['late', 'soon'])
})

test('timers survive a save and a load, including one that is overdue', () => {
  const storage = shim()
  const t = makeTimer({ label: '5 minutes', seconds: 300, recipeId: 'r1', step: 2 }, 0)
  saveTimers([t], storage)
  const back = loadTimers(storage)
  assert.deepEqual(back, [t])
  assert.equal(isDue(back[0], 10 * 60_000), true)
})

test('saving nothing removes the key rather than storing []', () => {
  const storage = shim()
  saveTimers([makeTimer({ label: 'x', seconds: 60 })], storage)
  saveTimers([], storage)
  assert.equal('recipebox:timers' in storage.data, false)
})

test('loadTimers drops anything it cannot trust', () => {
  const good = makeTimer({ label: 'ok', seconds: 60 })
  const bad = [
    null,
    'x',
    { id: 5, endsAt: 1, total: 60 },
    { id: 'a', endsAt: 'soon', total: 60 },
    { id: 'b', endsAt: 1, total: 0 },
    { id: 'c', endsAt: 1, total: MAX_SECONDS + 1 },
  ]
  const storage = shim({ 'recipebox:timers': JSON.stringify([...bad, good]) })
  assert.deepEqual(loadTimers(storage), [good])
})

test('loadTimers survives corrupt, wrong-shaped and unreadable storage', () => {
  assert.deepEqual(loadTimers(shim({ 'recipebox:timers': '{not json' })), [])
  assert.deepEqual(loadTimers(shim({ 'recipebox:timers': '{"a":1}' })), [])
  const throwing = { getItem() { throw new Error('blocked') } }
  assert.deepEqual(loadTimers(throwing), [])
  assert.doesNotThrow(() => saveTimers([makeTimer({ label: 'x', seconds: 60 })], {
    setItem() { throw new Error('full') },
    removeItem() {},
  }))
})

test('loadTimers caps how many it will draw', () => {
  const many = Array.from({ length: MAX_TIMERS + 5 }, (_, i) => makeTimer({ label: String(i), seconds: 60 }, i))
  const storage = shim({ 'recipebox:timers': JSON.stringify(many) })
  assert.equal(loadTimers(storage).length, MAX_TIMERS)
})

test('manualSeconds reads a bare number as minutes and refuses nonsense', () => {
  assert.equal(manualSeconds('10'), 600)
  assert.equal(manualSeconds(1, 30), 90)
  assert.equal(manualSeconds('', 45), 45)
  assert.equal(manualSeconds(0, 0), null)
  assert.equal(manualSeconds('abc'), null)
  assert.equal(manualSeconds(-3), null)
  assert.equal(manualSeconds(4 * 60), 4 * 3600)
  assert.equal(manualSeconds(4 * 60 + 1), null)
})
