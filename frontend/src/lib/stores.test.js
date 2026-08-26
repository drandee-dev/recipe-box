// The local backends of the three stores, plus the one line of every
// migrateLocal* that runs before it needs a network.
//
// This file exists because of a bug that reached production. Consolidating the
// three copies of readLocal/writeLocal into `localRows` meant renaming
// `readLocal()` to a method on a module-level handle — and the name chosen
// collided with a local `const rows` that already existed inside each
// migrateLocal*, three times:
//
//     const local = rows.read()      // resolved to the const below, not the handle
//     const rows = local.map(...)    // ...so this was a temporal dead zone
//     rows.clear()                   // and this called .clear() on an Array
//
// shopping.js had a fourth: `const rows = rows.read()` inside update(), which
// broke ticking an item off the list. All four threw "Cannot access 'rows'
// before initialization", none were caught by the existing suite, and none were
// caught by clicking round the app either — every one of them is on a path that
// only runs when signed in, and the browser check that was done ran signed out.
//
// So the rule these tests encode is narrow and worth stating: **exercise both
// backends, not just the one the app happens to use when you look at it.** A
// store's local half is testable with nothing but a localStorage shim, and the
// first line of each migrate is reachable without a client at all, because an
// empty local store returns before it asks for one.

import test from 'node:test'
import assert from 'node:assert/strict'

// Node has no localStorage without a flag. The stores only touch it when a
// method is called, never at import time, so installing this first is enough.
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

const { localRows } = await import('./backend.js')
const { makeStore, migrateLocalRecipes } = await import('./store.js')
const { makePlanStore, migrateLocalPlan } = await import('./plan.js')
const { makeShoppingStore, migrateLocalShopping } = await import('./shopping.js')

// Signed out, so every make*Store hands back the local backend.
const recipes = makeStore(null)
const plan = makePlanStore(null)
const shopping = makeShoppingStore(null)

function reset() {
  localStorage.clear()
}

// ---------------------------------------------------------------------------
// localRows
// ---------------------------------------------------------------------------

test('localRows round-trips and clears', () => {
  reset()
  const r = localRows('test:key')
  assert.deepEqual(r.read(), [])
  r.write([{ id: 'a' }])
  assert.deepEqual(r.read(), [{ id: 'a' }])
  r.clear()
  assert.deepEqual(r.read(), [])
})

test('an unparseable value reads as empty rather than throwing', () => {
  // A half-written value or a hand-edited devtools session must not take the
  // app down on mount.
  reset()
  localStorage.setItem('test:bad', '{not json')
  assert.deepEqual(localRows('test:bad').read(), [])
})

// ---------------------------------------------------------------------------
// recipes
// ---------------------------------------------------------------------------

test('a recipe saves, lists newest first, and removes', async () => {
  reset()
  await recipes.save({ id: 'r1', title: 'Older', created_at: '2026-08-01T00:00:00Z' })
  await recipes.save({ id: 'r2', title: 'Newer', created_at: '2026-08-02T00:00:00Z' })
  assert.deepEqual((await recipes.list()).map((r) => r.title), ['Newer', 'Older'])
  await recipes.remove('r1')
  assert.deepEqual((await recipes.list()).map((r) => r.id), ['r2'])
})

test('saving the same id updates in place instead of duplicating', async () => {
  reset()
  await recipes.save({ id: 'r1', title: 'First', created_at: '2026-08-01T00:00:00Z' })
  await recipes.save({ id: 'r1', title: 'Second', created_at: '2026-08-01T00:00:00Z' })
  const all = await recipes.list()
  assert.equal(all.length, 1)
  assert.equal(all[0].title, 'Second')
})

test('saveImage writes the mirror columns onto an existing recipe', async () => {
  reset()
  await recipes.save({ id: 'r1', title: 'X', created_at: '2026-08-01T00:00:00Z' })
  const saved = await recipes.saveImage('r1', { image_url: 'u', image_thumb_url: 't' })
  assert.equal(saved.image_url, 'u')
  assert.equal(saved.title, 'X', 'the rest of the row must survive')
  assert.equal(await recipes.saveImage('nope', {}), null)
})

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

test('a plan entry is found by its week and removed by id or by recipe', async () => {
  reset()
  await plan.add({ id: 'p1', recipe_id: 'r1', plan_date: '2026-08-12', slot: 'dinner' })
  await plan.add({ id: 'p2', recipe_id: 'r2', plan_date: '2026-08-20', slot: 'lunch' })
  assert.equal((await plan.listWeek('2026-08-10', '2026-08-16')).length, 1)
  await plan.remove('p1')
  assert.equal((await plan.listWeek('2026-08-10', '2026-08-16')).length, 0)
  await plan.removeByRecipe('r2')
  assert.equal((await plan.listWeek('2026-08-17', '2026-08-23')).length, 0)
})

test('an unknown slot is coerced to one the table accepts', async () => {
  reset()
  const row = await plan.add({ recipe_id: 'r1', plan_date: '2026-08-12', slot: 'brunch' })
  assert.equal(row.slot, 'dinner')
})

// ---------------------------------------------------------------------------
// shopping
// ---------------------------------------------------------------------------

test('a shopping row can be updated in place', async () => {
  // The regression: this method held `const rows = rows.read()`, which threw
  // "Cannot access 'rows' before initialization" the moment anything was ticked.
  reset()
  const row = await shopping.add({ week_start: '2026-08-10', name: 'flour', kind: 'manual' })
  const updated = await shopping.update(row.id, { checked: true })
  assert.equal(updated.checked, true)
  assert.equal(updated.name, 'flour')
  assert.equal((await shopping.listWeek('2026-08-10'))[0].checked, true)
})

test('updating a row that is not there returns null', async () => {
  reset()
  assert.equal(await shopping.update('missing', { checked: true }), null)
})

test('kind is pinned to check or manual', async () => {
  reset()
  const a = await shopping.add({ week_start: '2026-08-10', name: 'x', kind: 'check' })
  const b = await shopping.add({ week_start: '2026-08-10', name: 'y', kind: 'nonsense' })
  assert.equal(a.kind, 'check')
  assert.equal(b.kind, 'manual')
})

// ---------------------------------------------------------------------------
// the migrations
// ---------------------------------------------------------------------------

// Each of these reads local storage *before* it asks for a Supabase client, and
// returns early when there is nothing to upload. That first line is the one that
// was in a temporal dead zone, so calling these on an empty store is a complete
// test of the bug without needing a client, a network or a session.
test('every migrateLocal* returns 0 on an empty store rather than throwing', async () => {
  reset()
  assert.equal(await migrateLocalRecipes('u1'), 0)
  assert.equal(await migrateLocalPlan('u1'), 0)
  assert.equal(await migrateLocalShopping('u1'), 0)
})
