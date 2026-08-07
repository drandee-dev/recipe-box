import { strict as assert } from 'node:assert'
import test from 'node:test'
import { addDays, fromISODate, startOfWeek, toISODate } from './dates.js'

// Everything here is about one bug: a plan_date is a zoneless Postgres `date`,
// and any hop through UTC moves an evening meal to the day before west of
// Greenwich. toISODate has always been hand-formatted for that reason;
// fromISODate is its inverse and has to be hand-parsed for the same one.

test('fromISODate lands on local midnight, not UTC midnight', () => {
  const d = fromISODate('2026-08-09')
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getMonth(), 7)
  assert.equal(d.getDate(), 9)
  assert.equal(d.getHours(), 0)
})

test('fromISODate round-trips every day of a year through toISODate', () => {
  // The naive `new Date(iso)` passes a spot check in UTC and fails everywhere
  // else, so this walks a whole year rather than sampling.
  let day = new Date(2026, 0, 1)
  for (let i = 0; i < 365; i += 1) {
    const iso = toISODate(day)
    assert.equal(toISODate(fromISODate(iso)), iso, `round trip failed at ${iso}`)
    day = addDays(day, 1)
  }
})

test('a date parsed back from ISO finds the week the planner would show it in', () => {
  // 2026-08-09 is a Sunday, so it is the first day of its own week — the case
  // that sent an "Add to plan" meal into a week the planner was not showing.
  assert.equal(toISODate(startOfWeek(fromISODate('2026-08-09'))), '2026-08-09')
  assert.equal(toISODate(startOfWeek(fromISODate('2026-08-08'))), '2026-08-02')
})
