import { strict as assert } from 'node:assert'
import test from 'node:test'
import { baseServings, formatMinutes, groupByRecency, hostOf, isOvernight, metaParts } from './recipes.js'

// Time formatting and the overnight marker fail the way every reader in lib/
// fails: by producing a plausible answer. "720 min" was never wrong, it was
// just useless, and the wrong threshold or a bad prep/cook subtraction gives a
// string that looks right on every recipe you happen to look at.

test('minutes stay minutes below the hour-and-a-half threshold', () => {
  assert.equal(formatMinutes(25), '25 min')
  assert.equal(formatMinutes(89), '89 min')
})

test('long times read as hours', () => {
  assert.equal(formatMinutes(90), '1 hr 30')
  assert.equal(formatMinutes(120), '2 hr')
  assert.equal(formatMinutes(300), '5 hr')
  assert.equal(formatMinutes(720), '12 hr')
})

test('past a day the ladder moves on again', () => {
  // "168 hr" for a sourdough starter is the same unreadable number as "720 min",
  // one unit further along.
  assert.equal(formatMinutes(1439), '23 hr 59')
  assert.equal(formatMinutes(1440), '1 day')
  assert.equal(formatMinutes(2880), '2 days')
  assert.equal(formatMinutes(10080), '7 days')
})

test('a multi-day ferment is not "overnight" — it says how many days instead', () => {
  assert.equal(isOvernight({ total_min: 10080 }), false)
  assert.deepEqual(metaParts({ total_min: 10080, servings: 1 }), ['7 days', 'Serves 1'])
  // The boundary either side, since this is where the word stops being true.
  assert.equal(isOvernight({ total_min: 1439 }), true)
  assert.equal(isOvernight({ total_min: 1440 }), false)
})

test('a missing or nonsense time formats to nothing rather than "NaN min"', () => {
  assert.equal(formatMinutes(null), '')
  assert.equal(formatMinutes(undefined), '')
  assert.equal(formatMinutes(0), '')
  assert.equal(formatMinutes(-30), '')
  assert.equal(formatMinutes('not a number'), '')
})

test('a numeric string still formats — the column is an int but localStorage is JSON', () => {
  assert.equal(formatMinutes('45'), '45 min')
  assert.equal(formatMinutes('720'), '12 hr')
})

test('overnight is dead time, not long time', () => {
  // Twelve hours of which twenty-five minutes is work: not tonight.
  assert.equal(isOvernight({ total_min: 720, prep_min: 20, cook_min: 25 }), true)
  // Five hours of which five hours is the oven being on: tonight, if you start now.
  assert.equal(isOvernight({ total_min: 300, prep_min: 20, cook_min: 280 }), false)
})

test('with no prep/cook breakdown, only a very long total counts as overnight', () => {
  assert.equal(isOvernight({ total_min: 300 }), false)
  assert.equal(isOvernight({ total_min: 480 }), true)
  assert.equal(isOvernight({ total_min: 720, prep_min: null, cook_min: null }), true)
})

test('a recipe with no time is not overnight', () => {
  assert.equal(isOvernight({}), false)
  assert.equal(isOvernight({ total_min: 0 }), false)
  assert.equal(isOvernight(null), false)
})

test('the card replaces the number with the word; the sheet keeps both', () => {
  const focaccia = { total_min: 720, prep_min: 20, cook_min: 25, servings: 8 }
  assert.deepEqual(metaParts(focaccia), ['Overnight', 'Serves 8'])
  assert.deepEqual(metaParts(focaccia, { exact: true }), ['12 hr', 'overnight', 'Serves 8'])
})

test('an ordinary recipe reads the same on both surfaces', () => {
  const gnocchi = { total_min: 25, servings: 4 }
  assert.deepEqual(metaParts(gnocchi), ['25 min', 'Serves 4'])
  assert.deepEqual(metaParts(gnocchi, { exact: true }), ['25 min', 'Serves 4'])
})

test('servings that already say so are not prefixed twice', () => {
  assert.deepEqual(metaParts({ servings: 'Makes 12 buns' }), ['Makes 12 buns'])
  assert.deepEqual(metaParts({ servings: '4 servings' }), ['4 servings'])
})

test('a link card still has something to say', () => {
  assert.deepEqual(metaParts({}), ['Saved link'])
  assert.deepEqual(metaParts({ ingredients: [1, 2, 3] }), ['3 ingredients'])
})

test('recency bands split on age and keep the list order inside each', () => {
  const now = Date.parse('2026-08-07T12:00:00Z')
  const at = (iso, id) => ({ id, created_at: iso })
  const groups = groupByRecency(
    [
      at('2026-08-07T09:00:00Z', 'today'),
      at('2026-08-02T09:00:00Z', 'five days'),
      at('2026-07-25T09:00:00Z', 'two weeks'),
      at('2026-05-01T09:00:00Z', 'months'),
    ],
    now,
  )
  assert.deepEqual(
    groups.map((g) => [g.label, g.recipes.map((r) => r.id)]),
    [
      ['Recently saved', ['today', 'five days']],
      ['Earlier this month', ['two weeks']],
      ['Earlier', ['months']],
    ],
  )
})

test('an empty band is dropped rather than rendered as a heading over nothing', () => {
  const now = Date.parse('2026-08-07T12:00:00Z')
  const groups = groupByRecency([{ id: 'a', created_at: '2026-08-06T09:00:00Z' }], now)
  assert.deepEqual(
    groups.map((g) => g.label),
    ['Recently saved'],
  )
})

test('a recipe with no readable created_at files as old, not new', () => {
  const now = Date.parse('2026-08-07T12:00:00Z')
  const groups = groupByRecency([{ id: 'a' }, { id: 'b', created_at: 'nonsense' }], now)
  assert.deepEqual(
    groups.map((g) => [g.label, g.recipes.map((r) => r.id)]),
    [['Earlier', ['a', 'b']]],
  )
})

test('hostOf survives a stored URL that no longer parses', () => {
  assert.equal(hostOf('https://www.budgetbytes.com/crispy-gnocchi/'), 'budgetbytes.com')
  assert.equal(hostOf('not a url'), '')
  assert.equal(hostOf(null), '')
})

// ---------------------------------------------------------------------------
// baseServings — the number the scaler steps from (finding 12)
// ---------------------------------------------------------------------------

test('baseServings takes the first number out of a free-text serving count', () => {
  assert.equal(baseServings({ servings: '4' }), 4)
  assert.equal(baseServings({ servings: 4 }), 4)
  assert.equal(baseServings({ servings: 'Serves 4' }), 4)
  assert.equal(baseServings({ servings: 'Makes 12 cookies' }), 12)
})

test('baseServings takes the low end of a range', () => {
  // Stepping from the low end means the count on screen is a number the recipe
  // actually claimed.
  assert.equal(baseServings({ servings: 'Serves 4-6' }), 4)
})

test('baseServings gives nothing to step from when there is no number', () => {
  // No number means no stepper at all, rather than one anchored to a guess.
  assert.equal(baseServings({ servings: 'a crowd' }), null)
  assert.equal(baseServings({ servings: '' }), null)
  assert.equal(baseServings({ servings: null }), null)
  assert.equal(baseServings({}), null)
  assert.equal(baseServings(null), null)
  assert.equal(baseServings({ servings: '0' }), null)
})

test('metaParts can drop servings, for the surface that shows the stepper', () => {
  const recipe = { total_min: 30, servings: '4', ingredients: [] }
  assert.deepEqual(metaParts(recipe), ['30 min', 'Serves 4'])
  assert.deepEqual(metaParts(recipe, { servings: false }), ['30 min'])
})

test('dropping servings does not strand the meta line empty', () => {
  // The link-card fallback still has to fire, or the run renders as nothing and
  // reads as a bug.
  const linkCard = { servings: '4', ingredients: [] }
  assert.deepEqual(metaParts(linkCard, { servings: false }), ['Saved link'])
})
