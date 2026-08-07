import test from 'node:test'
import assert from 'node:assert/strict'
import { formatClock, parseDuration } from './cook.js'

test('parseDuration reads the common spellings', () => {
  assert.equal(parseDuration('Simmer for 10 minutes.').seconds, 600)
  assert.equal(parseDuration('Simmer for 10 mins.').seconds, 600)
  assert.equal(parseDuration('Simmer for 10 min.').seconds, 600)
  assert.equal(parseDuration('Rest 90 seconds').seconds, 90)
  assert.equal(parseDuration('Rest 90 secs').seconds, 90)
  assert.equal(parseDuration('Braise for 1 hour').seconds, 3600)
  assert.equal(parseDuration('Braise for 2 hrs').seconds, 7200)
})

test('parseDuration keeps the words it matched, for the chip label', () => {
  assert.equal(parseDuration('Bake for 25 minutes until golden.').label, '25 minutes')
})

test('parseDuration takes the low end of a range', () => {
  // Firing at 30 has already let it go past the point of checking.
  assert.equal(parseDuration('Bake 25-30 minutes').seconds, 25 * 60)
  assert.equal(parseDuration('Bake 25 to 30 minutes').seconds, 25 * 60)
})

test('parseDuration takes the first duration, not the longest', () => {
  const step = 'Fry for 2 minutes, then simmer for 20 minutes.'
  assert.equal(parseDuration(step).seconds, 120)
})

test('parseDuration ignores steps with no duration in them', () => {
  assert.equal(parseDuration('Season with salt and pepper.'), null)
  assert.equal(parseDuration(''), null)
  assert.equal(parseDuration(null), null)
  assert.equal(parseDuration(undefined), null)
})

test('parseDuration does not read a bare number as a duration', () => {
  // The step numbers, oven temperatures and tin sizes all live in this text.
  assert.equal(parseDuration('Heat the oven to 200 C.'), null)
  assert.equal(parseDuration('Use a 9 inch tin.'), null)
  assert.equal(parseDuration('Add 2 eggs.'), null)
})

test('parseDuration refuses anything longer than four hours', () => {
  // A countdown that cannot survive the phone locking must not claim it can.
  assert.equal(parseDuration('Chill for 12 hours'), null)
  assert.equal(parseDuration('Prove overnight, about 8 hrs'), null)
  assert.equal(parseDuration('Braise for 4 hours').seconds, 4 * 3600)
})

test('parseDuration is not left stateful by the global regex', () => {
  // The pattern carries /g so it can be re-run; a leaked lastIndex would make
  // every second call on the same text miss.
  const step = 'Simmer for 10 minutes.'
  assert.equal(parseDuration(step).seconds, 600)
  assert.equal(parseDuration(step).seconds, 600)
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
