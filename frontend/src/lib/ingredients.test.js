// Tests for the shopping list's parsing, merging and grouping.
//
// This file is first because of what it guards: a mistake here doesn't throw,
// it produces a plausible-looking list that is quietly missing an ingredient or
// short on a quantity, and the place that gets discovered is a shop. Everything
// in ingredients.js is pure, so none of this needs a DOM, a build step or a
// dependency — `node --test` runs it directly.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AISLE_ORDER,
  aisleFor,
  baseFor,
  buildShoppingList,
  formatQuantity,
  formatSource,
  groupByAisle,
  parseIngredient,
  readIngredient,
} from './ingredients.js'

// A recipe as the rest of the app hands it over: ingredients are objects whose
// item/qty/unit are null on every JSON-LD import, so the raw line is all there is.
function recipe(id, title, lines) {
  return {
    id,
    title,
    ingredients: lines.map((line) =>
      typeof line === 'string' ? { raw: line, item: null, qty: null, unit: null } : line,
    ),
  }
}

function planned(recipeId, date = '2026-08-09') {
  return { id: `plan-${recipeId}-${date}`, recipe_id: recipeId, plan_date: date, slot: 'dinner' }
}

// ---------------------------------------------------------------------------
// parseIngredient — the quantity forms real recipes actually use
// ---------------------------------------------------------------------------

test('parses a plain quantity, unit and name', () => {
  const got = parseIngredient('2 cups all-purpose flour, sifted')
  assert.equal(got.qty, 2)
  assert.equal(got.unit, 'cup')
  // Everything after the first comma is prep, not identity.
  assert.equal(got.name, 'all-purpose flour')
  assert.equal(got.parsed, true)
  // The original line survives intact for display.
  assert.equal(got.raw, '2 cups all-purpose flour, sifted')
})

test('parses a mixed number', () => {
  const got = parseIngredient('1 1/2 cups whole milk')
  assert.equal(got.qty, 1.5)
  assert.equal(got.unit, 'cup')
  assert.equal(got.name, 'whole milk')
})

test('parses a bare fraction', () => {
  const got = parseIngredient('3/4 tsp kosher salt')
  assert.equal(got.qty, 0.75)
  assert.equal(got.unit, 'tsp')
  assert.equal(got.name, 'kosher salt')
})

test('parses a vulgar fraction on its own and after a whole number', () => {
  assert.equal(parseIngredient('½ cup sugar').qty, 0.5)
  assert.equal(parseIngredient('1½ cups bread flour').qty, 1.5)
})

test('a range takes its low end', () => {
  // Buying for the smaller amount and topping up beats silently doubling.
  assert.equal(parseIngredient('2-3 tablespoons olive oil').qty, 2)
  assert.equal(parseIngredient('2 to 3 cloves garlic').qty, 2)
  assert.equal(parseIngredient('2 to 3 cloves garlic').unit, 'clove')
})

test('unit aliases collapse to one canonical unit', () => {
  for (const line of ['1 tablespoon butter', '1 tbsp butter', '1 tbs butter']) {
    assert.equal(parseIngredient(line).unit, 'tbsp', line)
  }
})

test('drops parentheticals but keeps the ingredient', () => {
  const got = parseIngredient('1 can (14.5 oz) crushed tomatoes')
  assert.equal(got.qty, 1)
  assert.equal(got.unit, 'can')
  assert.equal(got.name, 'crushed tomatoes')
})

test('strips list bullets, and leaves an unrecognised word in the name', () => {
  const got = parseIngredient('- 2 large eggs')
  assert.equal(got.qty, 2)
  assert.equal(got.unit, null)
  assert.equal(got.name, 'large eggs')
})

test('drops a trailing "of"', () => {
  assert.equal(parseIngredient('1 cup of rice').name, 'rice')
})

test('a line with no quantity is kept but marked unparsed', () => {
  const got = parseIngredient('Salt to taste')
  assert.equal(got.qty, null)
  assert.equal(got.parsed, false)
  // Trailing prep goes even without a comma, but the raw line is untouched.
  assert.equal(got.name, 'Salt')
  assert.equal(got.raw, 'Salt to taste')
})

test('empty input is not an ingredient', () => {
  assert.equal(parseIngredient(''), null)
  assert.equal(parseIngredient('   '), null)
  assert.equal(parseIngredient(null), null)
})

// ---------------------------------------------------------------------------
// formatQuantity — what the list actually reads like
// ---------------------------------------------------------------------------

test('formats fractions back into words a person would write', () => {
  assert.equal(formatQuantity(0.5, null), '1/2')
  assert.equal(formatQuantity(1.5, 'cup'), '1 1/2 cups')
  assert.equal(formatQuantity(1 / 3, 'cup'), '1/3 cup')
})

test('pluralises the unit only above one', () => {
  assert.equal(formatQuantity(1, 'cup'), '1 cup')
  assert.equal(formatQuantity(2, 'cup'), '2 cups')
  assert.equal(formatQuantity(3, 'clove'), '3 cloves')
})

test('no quantity formats to nothing at all', () => {
  assert.equal(formatQuantity(null, 'cup'), '')
})

// ---------------------------------------------------------------------------
// aisleFor / baseFor — the two places a keyword list can embarrass itself
// ---------------------------------------------------------------------------

test('the longest keyword wins, which is the whole point of the aisle index', () => {
  assert.equal(aisleFor('bell pepper'), 'Produce')
  assert.equal(aisleFor('black pepper'), 'Pantry')
  assert.equal(aisleFor('garlic'), 'Produce')
  assert.equal(aisleFor('garlic powder'), 'Pantry')
  assert.equal(aisleFor('ice cream'), 'Frozen')
  assert.equal(aisleFor('sour cream'), 'Dairy & Eggs')
})

test('an ingredient no keyword covers falls to Other', () => {
  assert.equal(aisleFor('zzz widget'), 'Other')
  assert.ok(AISLE_ORDER.includes('Other'))
})

test('plurals collapse onto the same base', () => {
  assert.equal(baseFor('chicken breasts'), 'chicken')
  assert.equal(baseFor('eggs'), 'egg')
  assert.equal(baseFor('berries'), 'berry')
  // -oes plurals are the ones a naive "drop the s" gets wrong.
  assert.equal(baseFor('tomatoes'), 'tomato')
  assert.equal(baseFor('potatoes'), 'potato')
})

// ---------------------------------------------------------------------------
// readIngredient — structured fields beat the raw line
// ---------------------------------------------------------------------------

test('a structured ingredient skips the parser', () => {
  const got = readIngredient({ raw: '2 cups flour', item: 'flour', qty: '2', unit: 'cups' })
  assert.equal(got.qty, 2)
  assert.equal(got.unit, 'cup')
  assert.equal(got.name, 'flour')
  assert.equal(got.parsed, true)
})

test('a structured ingredient with no quantity is unparsed, not broken', () => {
  const got = readIngredient({ raw: 'a pinch of salt', item: 'salt', qty: null, unit: null })
  assert.equal(got.qty, null)
  assert.equal(got.parsed, false)
  assert.equal(got.name, 'salt')
})

test('an unrecognised structured unit becomes null rather than itself', () => {
  assert.equal(readIngredient({ item: 'flour', qty: '1', unit: 'scoop' }).unit, null)
})

test('no item falls back to parsing the raw line', () => {
  const got = readIngredient({ raw: '3 cloves garlic', item: null, qty: null, unit: null })
  assert.equal(got.qty, 3)
  assert.equal(got.unit, 'clove')
  assert.equal(got.name, 'garlic')
})

// ---------------------------------------------------------------------------
// buildShoppingList — the merge, which is where a quiet error would live
// ---------------------------------------------------------------------------

test('the same ingredient in two recipes merges and sums', () => {
  const recipes = [recipe('r1', 'Pasta', ['2 cups flour']), recipe('r2', 'Cake', ['1 cup flour'])]
  const list = buildShoppingList([planned('r1'), planned('r2')], recipes)

  assert.equal(list.length, 1)
  assert.equal(list[0].qty, 3)
  assert.equal(list[0].unit, 'cup')
  // Both contributors stay named, so a merged total is traceable.
  assert.deepEqual(
    list[0].sources.map((s) => [s.title, s.qty]),
    [['Pasta', 2], ['Cake', 1]],
  )
})

test('the same ingredient in different units stays on separate lines', () => {
  // Converting invites the kind of quiet arithmetic error only found in a shop.
  const recipes = [recipe('r1', 'A', ['1 cup milk']), recipe('r2', 'B', ['200 ml milk'])]
  const list = buildShoppingList([planned('r1'), planned('r2')], recipes)
  assert.equal(list.length, 2)
})

test('a recipe planned twice in a week counts twice', () => {
  const recipes = [recipe('r1', 'Pasta', ['2 cups flour'])]
  const list = buildShoppingList([planned('r1', '2026-08-09'), planned('r1', '2026-08-11')], recipes)

  assert.equal(list.length, 1)
  assert.equal(list[0].qty, 4)
  assert.equal(list[0].sources.length, 1)
  assert.equal(list[0].sources[0].times, 2)
  assert.equal(list[0].sources[0].qty, 4)
})

test('unparsed lines never gain a quantity', () => {
  const recipes = [recipe('r1', 'A', ['Salt to taste']), recipe('r2', 'B', ['Salt to taste'])]
  const list = buildShoppingList([planned('r1'), planned('r2')], recipes)

  assert.equal(list.length, 1)
  assert.equal(list[0].parsed, false)
  assert.equal(list[0].qty, null)
  assert.equal(list[0].sources.length, 2)
})

test('different unparsed lines stand alone', () => {
  const recipes = [recipe('r1', 'A', ['Salt to taste', 'Freshly ground pepper'])]
  const list = buildShoppingList([planned('r1')], recipes)
  assert.equal(list.length, 2)
})

test('a plan row pointing at a deleted recipe is skipped, not crashed on', () => {
  const list = buildShoppingList([planned('gone')], [recipe('r1', 'A', ['2 cups flour'])])
  assert.deepEqual(list, [])
})

test('the list comes out in aisle order', () => {
  const recipes = [recipe('r1', 'A', ['2 cups flour', '1 cup milk', '1 onion'])]
  const list = buildShoppingList([planned('r1')], recipes)
  assert.deepEqual(
    list.map((i) => i.aisle),
    ['Produce', 'Dairy & Eggs', 'Pantry'],
  )
})

test('a plural and its singular are one line, not two', () => {
  // The plural handling in the merge key is load-bearing: get it wrong and the
  // list shows the same vegetable twice with neither total correct. Recipes
  // genuinely write it both ways — "3 tomatoes" in one, "1 tomato" in another.
  const recipes = [recipe('r1', 'Sauce', ['3 tomatoes']), recipe('r2', 'Salad', ['1 tomato'])]
  const list = buildShoppingList([planned('r1'), planned('r2')], recipes)
  assert.equal(list.length, 1)
  assert.equal(list[0].qty, 4)
})

// ---------------------------------------------------------------------------
// groupByAisle — variants together, but only inside one aisle
// ---------------------------------------------------------------------------

test('two variants of one base earn a heading', () => {
  const recipes = [recipe('r1', 'Dinner', ['2 chicken breasts', '4 chicken thighs'])]
  const groups = groupByAisle(buildShoppingList([planned('r1')], recipes))

  const meat = groups.find((g) => g.aisle === 'Meat & Seafood')
  assert.equal(meat.entries.length, 1)
  assert.equal(meat.entries[0].type, 'group')
  assert.equal(meat.entries[0].base, 'chicken')
  assert.equal(meat.entries[0].items.length, 2)
  // Never summed across variants: 2 breasts plus 4 thighs is not 6 of anything.
  assert.deepEqual(meat.entries[0].items.map((i) => i.qty), [2, 4])
})

test('a lone variant stays an ordinary line', () => {
  const recipes = [recipe('r1', 'Dinner', ['2 chicken breasts'])]
  const groups = groupByAisle(buildShoppingList([planned('r1')], recipes))
  const meat = groups.find((g) => g.aisle === 'Meat & Seafood')
  assert.equal(meat.entries[0].type, 'item')
})

test('grouping never reaches across an aisle', () => {
  // Both have base "pepper". They are not the same shopping decision.
  const recipes = [recipe('r1', 'Dinner', ['1 bell pepper', '1 tsp black pepper'])]
  const groups = groupByAisle(buildShoppingList([planned('r1')], recipes))

  assert.equal(groups.find((g) => g.aisle === 'Produce').entries[0].type, 'item')
  assert.equal(groups.find((g) => g.aisle === 'Pantry').entries[0].type, 'item')
})

// ---------------------------------------------------------------------------
// formatSource
// ---------------------------------------------------------------------------

test('a source reads as the recipe and what it wanted', () => {
  assert.equal(formatSource({ title: 'Pasta', qty: 2, unit: 'cup', times: 1 }), 'Pasta 2 cups')
  assert.equal(formatSource({ title: 'Pasta', qty: 4, unit: 'cup', times: 2 }), 'Pasta ×2 4 cups')
  assert.equal(formatSource({ title: 'Pasta', qty: null, unit: null, times: 1 }), 'Pasta')
})
