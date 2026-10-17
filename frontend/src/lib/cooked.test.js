// The cooked log and notes: counts, sorts, labels, search and the store paths.
//
// What this guards is a list that quietly lies: a count that includes a deleted
// recipe, a "most cooked" order that changes between draws, a note that search
// cannot find, or a write that erases notes it never knew about.

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
}
globalThis.localStorage = new MemoryStorage()

const { SORT_MODES, cookStats, cookedLabel, cookedShort, sortRecipes } = await import('./cooked.js')
const { makeCookStore, migrateLocalCookLog } = await import('./cooklog.js')
const { filterRecipes } = await import('./tags.js')
const { toRow, makeStore } = await import('./store.js')

const row = (recipe_id, cooked_at, id = `${recipe_id}-${cooked_at}`) => ({ id, recipe_id, cooked_at })
const rec = (id, title, created_at, extra = {}) => ({ id, title, created_at, ...extra })

test('stats count each recipe and keep its newest cook', () => {
  const stats = cookStats([
    row('a', '2026-10-01T10:00:00Z'),
    row('a', '2026-10-09T10:00:00Z'),
    row('a', '2026-10-05T10:00:00Z'),
    row('b', '2026-10-02T10:00:00Z'),
  ])
  assert.deepEqual(stats.get('a'), { count: 3, last: '2026-10-09T10:00:00Z' })
  assert.deepEqual(stats.get('b'), { count: 1, last: '2026-10-02T10:00:00Z' })
  assert.equal(stats.get('c'), undefined)
})

test('stats ignore malformed rows and empty input', () => {
  assert.equal(cookStats([{ recipe_id: 'a' }, { cooked_at: 'x' }, null]).size, 0)
  assert.equal(cookStats(undefined).size, 0)
})

const recipes = [
  rec('r1', 'Banana Bread', '2026-10-01T00:00:00Z'),
  rec('r2', 'apple pie', '2026-10-03T00:00:00Z'),
  rec('r3', 'Chili', '2026-10-02T00:00:00Z'),
  rec('r4', 'Dal', '2026-09-20T00:00:00Z'),
]
const stats = cookStats([
  row('r1', '2026-10-10T00:00:00Z'),
  row('r1', '2026-10-11T00:00:00Z'),
  row('r1', '2026-10-12T00:00:00Z'),
  row('r3', '2026-10-15T00:00:00Z'),
  row('r4', '2026-10-15T00:00:00Z'),
])

test('newest saved is created_at descending', () => {
  assert.deepEqual(sortRecipes(recipes, 'recent', stats).map((r) => r.id), ['r2', 'r3', 'r1', 'r4'])
})

test('recently cooked: cooked first by last cook, then the rest in saved order', () => {
  // r3 and r4 share a last-cooked instant, so the newer-saved one (r3) leads.
  assert.deepEqual(sortRecipes(recipes, 'cooked', stats).map((r) => r.id), ['r3', 'r4', 'r1', 'r2'])
})

test('most cooked: count, then recency, then saved order; never cooked last', () => {
  assert.deepEqual(sortRecipes(recipes, 'most', stats).map((r) => r.id), ['r1', 'r3', 'r4', 'r2'])
})

test('a to z ignores case', () => {
  assert.deepEqual(sortRecipes(recipes, 'az', stats).map((r) => r.title), ['apple pie', 'Banana Bread', 'Chili', 'Dal'])
})

test('every sort is stable across calls and leaves its input alone', () => {
  const copy = JSON.stringify(recipes)
  for (const mode of SORT_MODES) {
    const a = sortRecipes(recipes, mode, stats).map((r) => r.id)
    const b = sortRecipes([...recipes].reverse(), mode, stats).map((r) => r.id)
    assert.deepEqual(a, b, `${mode} depends on input order`)
  }
  assert.equal(JSON.stringify(recipes), copy)
})

test('an unknown mode falls back to newest saved', () => {
  assert.deepEqual(sortRecipes(recipes, 'bogus', stats).map((r) => r.id), ['r2', 'r3', 'r1', 'r4'])
})

test('labels: nothing when never cooked, once, and a count with a date', () => {
  assert.equal(cookedLabel(undefined), null)
  assert.equal(cookedLabel({ count: 0, last: '2026-10-01T12:00:00Z' }), null)
  assert.match(cookedLabel({ count: 1, last: '2026-10-12T12:00:00Z' }), /^Cooked once, last Oct 12$/)
  assert.match(cookedLabel({ count: 3, last: '2026-10-12T12:00:00Z' }), /^Cooked 3 times, last Oct 12$/)
  assert.equal(cookedShort({ count: 3, last: 'x' }), 'Cooked 3×')
  assert.equal(cookedShort({ count: 1, last: 'x' }), 'Cooked once')
  assert.equal(cookedShort(undefined), null)
  assert.equal(cookedLabel({ count: 2, last: 'not a date' }), 'Cooked 2 times')
})

test('search finds a recipe by its note, and still not by its steps', () => {
  const list = [
    rec('a', 'Cake', '2026-10-01', { notes: 'Used half the sugar and it was better', instructions: ['Whisk the eggs'] }),
    rec('b', 'Soup', '2026-10-02', { instructions: ['Stir with half a cup of water'] }),
  ]
  assert.deepEqual(filterRecipes(list, { query: 'half sugar' }).map((r) => r.id), ['a'])
  assert.deepEqual(filterRecipes(list, { query: 'whisk' }).map((r) => r.id), [])
})

test('a write that does not know about notes leaves the column out', () => {
  assert.equal('notes' in toRow({ id: 'x', title: 'T' }), false)
  assert.equal(toRow({ id: 'x', title: 'T', notes: null }).notes, null)
  assert.equal(toRow({ id: 'x', title: 'T', notes: '' }).notes, null)
  assert.equal(toRow({ id: 'x', title: 'T', notes: 'half sugar' }).notes, 'half sugar')
  assert.equal(toRow({ id: 'x', title: 'T', notes: 'y'.repeat(5000) }).notes.length, 4000)
})

test('notes survive a favourite toggle on the local store', async () => {
  localStorage.clear()
  const store = makeStore(null)
  await store.save({ id: 'r1', title: 'Cake', notes: 'less sugar', favorite: false })
  const saved = (await store.list())[0]
  await store.save({ ...saved, favorite: true })
  assert.equal((await store.list())[0].notes, 'less sugar')
})

test('the cook log: add, list, remove one, and the log goes with a deleted recipe', async () => {
  localStorage.clear()
  const log = makeCookStore(null)
  const a = await log.add({ recipe_id: 'r1' })
  await log.add({ recipe_id: 'r1' })
  await log.add({ recipe_id: 'r2' })
  assert.equal((await log.list()).length, 3)
  assert.ok(a.id && a.cooked_at)
  await log.remove(a.id)
  assert.equal((await log.list()).filter((r) => r.recipe_id === 'r1').length, 1)
  await log.removeByRecipe('r1')
  assert.deepEqual((await log.list()).map((r) => r.recipe_id), ['r2'])
})

test('migrating with nothing stored returns before it needs a client', async () => {
  localStorage.clear()
  assert.equal(await migrateLocalCookLog('u1'), 0)
})
