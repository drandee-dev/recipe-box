// Pass C: servings per planned meal, staples, moved aisles, aisle order, the
// shared text, and the store paths that carry them.
//
// What this guards is the same thing ingredients.test.js guards: a list that is
// quietly wrong. Servings can be short a quantity, a staple can swallow an item
// that was not one, and a "tick" can stop meaning what it meant. The last is the
// hard constraint from pass B: check rows in shopping_items are stored under the
// merge key (name|dimension), so nothing here may change a key.

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

const { applyPrefs, buildShoppingList, groupByAisle, shoppingText } = await import('./ingredients.js')
const { EMPTY_PREFS, effectiveAisleOrder, makePrefsStore, migrateLocalPrefs, moveAisle, sanitizePrefs, setAisle, toggleStaple } =
  await import('./prefs.js')
const { makePlanStore, safeServings } = await import('./plan.js')
const { makeShoppingStore } = await import('./shopping.js')

function recipe(id, title, servings, lines) {
  return {
    id,
    title,
    servings,
    ingredients: lines.map((raw) => ({ raw, item: null, qty: null, unit: null })),
  }
}
const meal = (recipe_id, servings, date = '2026-08-09') => ({
  id: `${recipe_id}-${date}-${servings}`,
  recipe_id,
  plan_date: date,
  slot: 'dinner',
  servings,
})

// ---------------------------------------------------------------------------
// servings per meal
// ---------------------------------------------------------------------------

test('a meal planned for double the servings asks the list for double', () => {
  const recipes = [recipe('r1', 'Pasta', '4', ['2 cups flour', '1 onion'])]
  const list = buildShoppingList([meal('r1', 8)], recipes)
  const flour = list.find((i) => i.name === 'flour')
  const onion = list.find((i) => i.name === 'onion')
  assert.equal(flour.qty, 4)
  assert.equal(onion.qty, 2)
})

test('no stored servings, or a recipe with no readable count, is not scaled', () => {
  const recipes = [recipe('r1', 'Pasta', '4', ['2 cups flour']), recipe('r2', 'Soup', 'a crowd', ['2 cups stock'])]
  assert.equal(buildShoppingList([meal('r1', null)], recipes)[0].qty, 2)
  assert.equal(buildShoppingList([meal('r2', 12)], recipes)[0].qty, 2)
})

test('scaling moves the quantity and nothing about the merge key', () => {
  const recipes = [recipe('r1', 'Pasta', '4', ['2 cups flour', '500 g tomatoes', '1 tsp salt'])]
  const plain = buildShoppingList([meal('r1', null)], recipes).map((i) => i.key).sort()
  const scaled = buildShoppingList([meal('r1', 10)], recipes).map((i) => i.key).sort()
  // Ticks are stored under these. If they differed, planning for a crowd would
  // untick a week of shopping.
  assert.deepEqual(scaled, plain)
})

test('a scaled meal and an unscaled one merge into one line, summed correctly', () => {
  const recipes = [recipe('r1', 'A', '2', ['100 g butter']), recipe('r2', 'B', '4', ['200 g butter'])]
  const list = buildShoppingList([meal('r1', 4), meal('r2', null)], recipes)
  assert.equal(list.length, 1)
  assert.equal(list[0].qty, 400)
})

test('servings the table would refuse are stored as null, not thrown', () => {
  assert.equal(safeServings(0), null)
  assert.equal(safeServings(501), null)
  assert.equal(safeServings('abc'), null)
  assert.equal(safeServings(null), null)
  assert.equal(safeServings(6.4), 6)
})

// ---------------------------------------------------------------------------
// leftovers
// ---------------------------------------------------------------------------

test('a leftovers meal asks the list for nothing, and is not named as a source', () => {
  const recipes = [recipe('r1', 'Pasta', '4', ['2 cups flour', '1 onion']), recipe('r2', 'Cake', '4', ['1 cup flour'])]
  const plain = buildShoppingList([meal('r1', null), meal('r2', null)], recipes)
  assert.equal(plain.find((i) => i.name === 'flour').qty, 3)
  const withLeft = buildShoppingList([meal('r1', null), { ...meal('r2', null), leftover: true }], recipes)
  const flour = withLeft.find((i) => i.name === 'flour')
  // Only the bought meal contributes: 2 cups, from Pasta alone.
  assert.equal(flour.qty, 2)
  assert.deepEqual(flour.sources.map((s) => s.title), ['Pasta'])
})

test('a week of only leftovers is an empty list', () => {
  const recipes = [recipe('r1', 'Pasta', '4', ['2 cups flour'])]
  assert.equal(buildShoppingList([{ ...meal('r1', null), leftover: true }], recipes).length, 0)
})

test('leftover is false unless said, and can be flipped on a planned meal', async () => {
  localStorage.clear()
  const plan = makePlanStore(null)
  const row = await plan.add({ id: 'p1', recipe_id: 'r1', plan_date: '2026-08-12', slot: 'dinner' })
  assert.equal(row.leftover, false)
  assert.equal((await plan.update('p1', { leftover: true })).leftover, true)
  assert.equal((await plan.update('p1', { leftover: 'yes please' })).leftover, true)
  assert.equal((await plan.update('p1', { leftover: false })).leftover, false)
  const added = await plan.add({ id: 'p2', recipe_id: 'r1', plan_date: '2026-08-13', slot: 'lunch', leftover: true })
  assert.equal(added.leftover, true)
})

// ---------------------------------------------------------------------------
// staples and moved aisles
// ---------------------------------------------------------------------------

const weekRecipes = [recipe('r1', 'Pasta', '4', ['1 tbsp kosher salt', '2 onions']), recipe('r2', 'Stew', '4', ['3 tsp kosher salt'])]

test('a staple is flagged by name, whatever unit this week used', () => {
  const list = buildShoppingList([meal('r1', null), meal('r2', null)], weekRecipes)
  const prefs = toggleStaple(EMPTY_PREFS, list.find((i) => i.name === 'kosher salt').nameKey)
  const marked = applyPrefs(list, prefs)
  assert.equal(marked.find((i) => i.name === 'kosher salt').staple, true)
  assert.equal(marked.find((i) => i.name === 'onion' || i.name === 'onions').staple, false)
})

test('prefs never change a line key', () => {
  const list = buildShoppingList([meal('r1', null)], weekRecipes)
  let prefs = toggleStaple(EMPTY_PREFS, list[0].nameKey)
  prefs = setAisle(prefs, list[0].nameKey, 'Bakery', list[0].aisle)
  assert.deepEqual(applyPrefs(list, prefs).map((i) => i.key), list.map((i) => i.key))
})

test('a moved aisle puts the item there, and moving it back forgets the choice', () => {
  const list = buildShoppingList([meal('r1', null)], weekRecipes)
  const salt = list.find((i) => i.name === 'kosher salt')
  let prefs = setAisle(EMPTY_PREFS, salt.nameKey, 'Bakery', salt.aisle)
  assert.equal(applyPrefs(list, prefs).find((i) => i.name === 'kosher salt').aisle, 'Bakery')
  prefs = setAisle(prefs, salt.nameKey, salt.aisle, salt.aisle)
  assert.deepEqual(prefs.aisle_map, {})
})

test('an unparsed line has no nameKey, so no staple or aisle can attach to it', () => {
  const recipes = [recipe('r1', 'X', '2', ['salt to taste'])]
  const [item] = buildShoppingList([meal('r1', null)], recipes)
  if (!item.parsed) {
    assert.equal(item.nameKey, null)
    assert.equal(applyPrefs([item], { staples: ['salt to taste'], aisle_map: {}, aisle_order: [] })[0].staple, false)
  }
})

// ---------------------------------------------------------------------------
// aisle order
// ---------------------------------------------------------------------------

test('aisle order: yours first, then any the saved order leaves out', () => {
  const prefs = { ...EMPTY_PREFS, aisle_order: ['Bakery', 'Produce'] }
  const order = effectiveAisleOrder(prefs)
  assert.deepEqual(order.slice(0, 2), ['Bakery', 'Produce'])
  assert.equal(new Set(order).size, order.length)
  assert.equal(order.length, effectiveAisleOrder(EMPTY_PREFS).length)
})

test('moving an aisle up or down stops at the ends', () => {
  const first = effectiveAisleOrder(EMPTY_PREFS)[0]
  assert.equal(moveAisle(EMPTY_PREFS, first, -1), EMPTY_PREFS)
  const down = moveAisle(EMPTY_PREFS, first, 1)
  assert.equal(effectiveAisleOrder(down)[1], first)
})

test('groupByAisle follows the order it is given', () => {
  const items = buildShoppingList([meal('r1', null)], weekRecipes)
  const normal = groupByAisle(items).map((g) => g.aisle)
  const flipped = groupByAisle(items, [...effectiveAisleOrder(EMPTY_PREFS)].reverse()).map((g) => g.aisle)
  assert.deepEqual(flipped, [...normal].reverse())
})

test('sanitizePrefs drops what the table would refuse', () => {
  const clean = sanitizePrefs({
    staples: ['salt', 'salt', 42, '', 'x'.repeat(200)],
    aisle_map: { salt: 'Bakery', pepper: 'Nowhere' },
    aisle_order: ['Bakery', 'Bakery', 'Nowhere'],
  })
  assert.deepEqual(clean.staples, ['salt'])
  assert.deepEqual(clean.aisle_map, { salt: 'Bakery' })
  assert.deepEqual(clean.aisle_order, ['Bakery'])
  assert.deepEqual(sanitizePrefs(null), { staples: [], aisle_map: {}, aisle_order: [] })
})

// ---------------------------------------------------------------------------
// shared text
// ---------------------------------------------------------------------------

test('shared text is what is still to buy: no picked lines, no staples', () => {
  const items = applyPrefs(buildShoppingList([meal('r1', null)], weekRecipes), {
    staples: ['kosher salt'],
    aisle_map: {},
    aisle_order: [],
  })
  const onion = items.find((i) => i.name.startsWith('onion'))
  const text = shoppingText({
    label: 'Shopping list, Aug 9 - 15',
    groups: groupByAisle(items),
    manual: [
      { id: 'm1', name: 'milk', checked: false },
      { id: 'm2', name: 'tea', checked: true },
    ],
    isPicked: () => false,
  })
  assert.match(text, /^Shopping list, Aug 9 - 15\n\n/)
  assert.match(text, /- 2 onions?/)
  assert.doesNotMatch(text, /salt/)
  assert.match(text, /- milk/)
  assert.doesNotMatch(text, /tea/)
  const picked = shoppingText({
    label: 'x',
    groups: groupByAisle(items),
    manual: [],
    isPicked: (key) => key === onion.key,
  })
  assert.equal(picked, '')
})

// ---------------------------------------------------------------------------
// the stores (local backends)
// ---------------------------------------------------------------------------

test('a planned meal can be moved and re-scaled, and only those fields', async () => {
  localStorage.clear()
  const plan = makePlanStore(null)
  await plan.add({ id: 'p1', recipe_id: 'r1', plan_date: '2026-08-12', slot: 'dinner' })
  const moved = await plan.update('p1', {
    plan_date: '2026-08-14',
    slot: 'lunch',
    servings: 6,
    recipe_id: 'hijack',
    id: 'other',
  })
  assert.equal(moved.plan_date, '2026-08-14')
  assert.equal(moved.slot, 'lunch')
  assert.equal(moved.servings, 6)
  assert.equal(moved.recipe_id, 'r1')
  assert.equal(moved.id, 'p1')
  assert.equal(await plan.update('missing', { servings: 2 }), null)
  const cleared = await plan.update('p1', { servings: null })
  assert.equal(cleared.servings, null)
})

test('prune removes only rows for weeks before the cutoff, never a null week', async () => {
  localStorage.clear()
  const shopping = makeShoppingStore(null)
  await shopping.add({ id: 'old', week_start: '2026-05-03', name: 'a', kind: 'manual' })
  await shopping.add({ id: 'edge', week_start: '2026-08-02', name: 'b', kind: 'manual' })
  await shopping.add({ id: 'new', week_start: '2026-08-09', name: 'c', kind: 'check' })
  await shopping.add({ id: 'none', week_start: null, name: 'd', kind: 'manual' })
  await shopping.prune('2026-08-02')
  const left = JSON.parse(localStorage.getItem('recipebox:shopping')).map((r) => r.id).sort()
  assert.deepEqual(left, ['edge', 'new', 'none'])
})

test('a hand-added item from a recipe keeps the recipe it came from', async () => {
  localStorage.clear()
  const shopping = makeShoppingStore(null)
  const row = await shopping.add({ week_start: '2026-08-09', name: '2 cups flour', kind: 'manual', recipe_id: 'r1' })
  assert.equal(row.recipe_id, 'r1')
  const plain = await shopping.add({ week_start: '2026-08-09', name: 'milk', kind: 'manual' })
  assert.equal(plain.recipe_id, null)
})

test('prefs round-trip locally, and a bad stored value reads as empty', async () => {
  localStorage.clear()
  const store = makePrefsStore(null)
  assert.deepEqual(await store.load(), { staples: [], aisle_map: {}, aisle_order: [] })
  await store.save({ staples: ['salt'], aisle_map: { salt: 'Pantry' }, aisle_order: ['Pantry'] })
  assert.deepEqual((await store.load()).staples, ['salt'])
  localStorage.setItem('recipebox:shopprefs', '{not json')
  assert.deepEqual(await store.load(), { staples: [], aisle_map: {}, aisle_order: [] })
})

test('migrating with nothing stored returns before it needs a client', async () => {
  localStorage.clear()
  assert.equal(await migrateLocalPrefs('u1'), false)
  localStorage.setItem('recipebox:shopprefs', JSON.stringify({ staples: [], aisle_map: {}, aisle_order: [] }))
  assert.equal(await migrateLocalPrefs('u1'), false)
  assert.equal(localStorage.getItem('recipebox:shopprefs'), null)
})
