// The rule that turns a drag into "previous week", "next week" or nothing. The
// gesture plumbing (where it may start, what it suppresses) is checked with real
// touch events in a browser; this is the decision, which is pure.

import test from 'node:test'
import assert from 'node:assert/strict'

import { NO_SWIPE, SWIPE_SLOP, WEEK_SWIPE_THRESHOLD, weekSwipeDirection } from './useWeekSwipe.js'

test('dragging left turns to the next week, right to the previous, like a page', () => {
  assert.equal(weekSwipeDirection(-120), 1)
  assert.equal(weekSwipeDirection(120), -1)
})

test('a short drag does nothing, and the threshold itself counts', () => {
  assert.equal(weekSwipeDirection(-(WEEK_SWIPE_THRESHOLD - 1)), 0)
  assert.equal(weekSwipeDirection(WEEK_SWIPE_THRESHOLD - 1), 0)
  assert.equal(weekSwipeDirection(-WEEK_SWIPE_THRESHOLD), 1)
  assert.equal(weekSwipeDirection(WEEK_SWIPE_THRESHOLD), -1)
})

test('a drag that is more up or down than sideways is a scroll, never a week change', () => {
  assert.equal(weekSwipeDirection(-80, -200), 0)
  assert.equal(weekSwipeDirection(80, 200), 0)
  // Equal is not "more sideways".
  assert.equal(weekSwipeDirection(-100, 100), 0)
  assert.equal(weekSwipeDirection(-100, -99), 1)
})

test('the slop is smaller than the threshold, or a swipe could not get started', () => {
  assert.ok(SWIPE_SLOP < WEEK_SWIPE_THRESHOLD)
})

test('the places a swipe must not start are named, and buttons are not among them', () => {
  for (const sel of ['.planner-entry-swipe', '.shopping-tools', '.sheet-backdrop', 'input', 'textarea', 'select']) {
    assert.ok(NO_SWIPE.includes(sel), `${sel} should refuse a week swipe`)
  }
  // An empty day is a button; refusing buttons is what made the old swipe dead.
  assert.ok(!/(^|,\s*)button\b/.test(NO_SWIPE))
  assert.ok(!/(^|,\s*)a(,|$)/.test(NO_SWIPE))
})
