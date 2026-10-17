// splitAmount: the bold amount on an ingredient line. The one thing that must
// never happen is the line changing, so every case also checks the parts join
// back into the input.

import test from 'node:test'
import assert from 'node:assert/strict'

import { splitAmount } from './ingredients.js'

const cases = [
  ['2 cups all-purpose flour, sifted', '2 cups'],
  ['1 1/2 tbsp kosher salt', '1 1/2 tbsp'],
  ['½ tsp. baking soda', '½ tsp.'],
  // The parser treats "clove" as a unit, so it is bold with its number.
  ['2-3 cloves garlic', '2-3 cloves'],
  ['3 eggs', '3'],
  ['1 cup (200g) sugar', '1 cup'],
  ['2 (14 oz) cans tomatoes', '2'],
  ['500 g pasta', '500 g'],
  ['- 1 lb butter', '1 lb'],
  ['Salt, to taste', ''],
  ['', ''],
]

for (const [line, bold] of cases) {
  test(`amount of "${line}" is "${bold}" and the line is unchanged`, () => {
    const { lead, bold: got, rest } = splitAmount(line)
    assert.equal(got, bold)
    assert.equal(lead + got + rest, line)
  })
}

test('a bracketed weight stays out of the bold part', () => {
  assert.equal(splitAmount('1 cup (200g) sugar').rest, ' (200g) sugar')
})

test('a word that only looks like a unit is not taken', () => {
  // "gallery" starts with a unit-looking letter run but is not one.
  assert.equal(splitAmount('2 gallery tiles').bold, '2')
})
