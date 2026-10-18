import test from 'node:test'
import assert from 'node:assert/strict'
import { findDurations, formatClock, splitDurations } from './cook.js'

const secs = (step) => findDurations(step).map((d) => d.seconds)

test('findDurations reads the common spellings', () => {
  assert.deepEqual(secs('Simmer for 10 minutes.'), [600])
  assert.deepEqual(secs('Simmer for 10 mins.'), [600])
  assert.deepEqual(secs('Simmer for 10 min.'), [600])
  assert.deepEqual(secs('Rest 90 seconds'), [90])
  assert.deepEqual(secs('Rest 90 secs'), [90])
  assert.deepEqual(secs('Braise for 1 hour'), [3600])
  assert.deepEqual(secs('Braise for 2 hrs'), [7200])
})

test('findDurations keeps the words it matched, for the chip label', () => {
  assert.equal(findDurations('Bake for 25 minutes until golden.')[0].label, '25 minutes')
})

test('findDurations takes the low end of a range', () => {
  // Firing at 30 has already let it go past the point of checking.
  assert.deepEqual(secs('Bake 25-30 minutes'), [25 * 60])
  assert.deepEqual(secs('Bake 25 to 30 minutes'), [25 * 60])
})

test('findDurations returns every duration, in reading order', () => {
  assert.deepEqual(secs('Fry for 2 minutes, then simmer for 20 minutes.'), [120, 1200])
  assert.deepEqual(secs('Brown the butter 6-8 minutes and cool 15 minutes.'), [360, 900])
})

test('findDurations joins an hours-and-minutes pair into one timer', () => {
  assert.deepEqual(secs('Roast 1 hr 30 min'), [5400])
  assert.deepEqual(secs('Roast 1 hour and 15 minutes'), [4500])
  assert.equal(findDurations('Roast 1 hr 30 min')[0].label, '1 hr 30 min')
  // Not a pair: words sit between, or the order runs the wrong way.
  assert.deepEqual(secs('Chill 1 hour, then bake 30 minutes'), [3600, 1800])
  assert.deepEqual(secs('Rest 5 minutes 1 hour'), [300, 3600])
  // A range is never folded into its neighbour.
  assert.deepEqual(secs('Bake 1 hr 20-30 min'), [3600, 1200])
})

test('findDurations ignores steps with no duration in them', () => {
  assert.deepEqual(secs('Season with salt and pepper.'), [])
  assert.deepEqual(secs(''), [])
  assert.deepEqual(secs(null), [])
  assert.deepEqual(secs(undefined), [])
})

test('findDurations does not read a bare number as a duration', () => {
  // The step numbers, oven temperatures and tin sizes all live in this text.
  assert.deepEqual(secs('Heat the oven to 200 C.'), [])
  assert.deepEqual(secs('Use a 9 inch tin.'), [])
  assert.deepEqual(secs('Add 2 eggs.'), [])
})

test('findDurations refuses anything longer than four hours', () => {
  // A countdown that cannot survive the phone locking must not claim it can.
  assert.deepEqual(secs('Chill for 12 hours'), [])
  assert.deepEqual(secs('Prove overnight, about 8 hrs'), [])
  assert.deepEqual(secs('Braise for 4 hours'), [4 * 3600])
  // The long one is dropped, the short one in the same step survives.
  assert.deepEqual(secs('Chill 12 hours, then bake 20 minutes'), [1200])
})

test('findDurations is not left stateful by the global regex', () => {
  // The pattern carries /g so it can be re-run; a leaked lastIndex would make
  // every second call on the same text miss.
  const step = 'Simmer for 10 minutes.'
  assert.deepEqual(secs(step), [600])
  assert.deepEqual(secs(step), [600])
})

test('splitDurations reassembles to exactly the step', () => {
  for (const step of [
    'Brown the butter 6-8 minutes and cool 15 minutes.',
    'Roast 1 hr 30 min until tender.',
    '10 minutes',
    'Season with salt.',
    'Chill 12 hours, then bake 20 minutes.',
    '',
  ]) {
    assert.equal(splitDurations(step).map((p) => p.text).join(''), step)
  }
})

test('splitDurations marks only the durations', () => {
  const pieces = splitDurations('Cool 15 minutes, then serve.')
  assert.deepEqual(pieces, [
    { text: 'Cool ' },
    { text: '15 minutes', seconds: 900 },
    { text: ', then serve.' },
  ])
})

test('formatClock pads and grows an hours field only when needed', () => {
  assert.equal(formatClock(0), '0:00')
  assert.equal(formatClock(9), '0:09')
  assert.equal(formatClock(60), '1:00')
  assert.equal(formatClock(599), '9:59')
  assert.equal(formatClock(3600), '1:00:00')
  assert.equal(formatClock(3661), '1:01:01')
})

test('formatClock never shows a negative clock', () => {
  assert.equal(formatClock(-5), '0:00')
  assert.equal(formatClock(NaN), '0:00')
})
