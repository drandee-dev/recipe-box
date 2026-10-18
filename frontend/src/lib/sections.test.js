import test from 'node:test'
import assert from 'node:assert/strict'
import { headingAt, ingredientGroups } from './sections.js'

test('a heading is drawn once, above the first line of each run', () => {
  const groups = [null, null, 'Crust', 'Crust', 'Topping', 'Topping', 'Crust']
  const drawn = groups.map((_, n) => headingAt(groups, n))
  assert.deepEqual(drawn, [null, null, 'Crust', null, 'Topping', null, 'Crust'])
})

test('no groups, or a line with no section, draws nothing', () => {
  assert.equal(headingAt(null, 0), null)
  assert.equal(headingAt(undefined, 3), null)
  assert.equal(headingAt([null, 'A', null], 2), null)
  assert.equal(headingAt([], 0), null)
})

test('the first line of a recipe that opens with a section gets its heading', () => {
  assert.equal(headingAt(['Sauce', 'Sauce'], 0), 'Sauce')
})

test('ingredientGroups reads the group off each line and is null when none is named', () => {
  assert.deepEqual(
    ingredientGroups([{ raw: 'a' }, { raw: 'b', group: 'Topping' }, 'c', null]),
    [null, 'Topping', null, null],
  )
  assert.equal(ingredientGroups([{ raw: 'a' }, { raw: 'b' }]), null)
  assert.equal(ingredientGroups(undefined), null)
})
