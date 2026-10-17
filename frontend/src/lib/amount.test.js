// splitAmount: the bold amount on an ingredient line. The one thing that must
// never happen is the line changing, so every case also checks the parts join
// back into the input.

import test from 'node:test'
import assert from 'node:assert/strict'

import { QTY_COLUMN_MAX, formatSources, qtyColumnCh, splitAmount } from './ingredients.js'

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

test('the quantity column is as wide as the longest amount, capped', () => {
  assert.equal(qtyColumnCh(['2 onions', '1 1/2 tbsp salt', 'Pepper, to taste']), '1 1/2 tbsp'.length)
  assert.equal(qtyColumnCh(['1 to 2 tablespoons or maybe more olive oil']), Math.min(QTY_COLUMN_MAX, splitAmount('1 to 2 tablespoons or maybe more olive oil').bold.trim().length))
  assert.ok(qtyColumnCh(['1 1/2 to 2 1/2 tablespoons oil']) <= QTY_COLUMN_MAX)
})

test('spelled-out units that are on most recipes fit the column uncut', () => {
  // These are the common lines a density pass must not turn into two rows.
  assert.equal(qtyColumnCh(['2 tablespoons olive oil']), '2 tablespoons'.length)
  assert.equal(qtyColumnCh(['1 teaspoon salt', '2 tablespoons oil']), '2 tablespoons'.length)
  assert.ok(QTY_COLUMN_MAX >= '2 tablespoons'.length)
})

test('no amounts anywhere means no column at all', () => {
  assert.equal(qtyColumnCh(['Salt, to taste', 'Pepper']), 0)
  assert.equal(qtyColumnCh([]), 0)
})

test('shopping sources fit on one line: the first recipe, then +N', () => {
  const s = (title, times = 1) => ({ title, times })
  assert.equal(formatSources([s('Pasta')]), 'Pasta')
  assert.equal(formatSources([s('Pasta', 2)]), 'Pasta ×2')
  assert.equal(formatSources([s('Pasta'), s('Soup'), s('Salad')]), 'Pasta +2')
  assert.equal(formatSources([]), '')
  assert.equal(formatSources(undefined), '')
})
