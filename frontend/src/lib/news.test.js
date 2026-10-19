// The news list is hand-written on every release, which is exactly how it
// drifts: a version bumped in one place and not the other, two entries with
// one id (the second would never show, since closing the first hides both),
// or a new entry added at the bottom where the banner never looks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { APP_VERSION, NEWS, cleanHighlights, latestNews, markNewsSeen, newsSeen } from './news.js'

test('every entry has an id, a known kind, a title and something to say', () => {
  for (const entry of NEWS) {
    assert.ok(entry.id, 'missing id')
    assert.ok(['upcoming', 'release'].includes(entry.kind), `${entry.id}: kind ${entry.kind}`)
    assert.ok(entry.title, `${entry.id}: no title`)
    assert.ok(entry.body || entry.notes?.length, `${entry.id}: nothing to show`)
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, `${entry.id}: date`)
  }
})

test('an update block, when there is one, has both a heading and what to do', () => {
  // The large banner renders these two strings and nothing else; one missing
  // would put an empty card on every user's screen that they must close.
  for (const entry of NEWS.filter((e) => e.update)) {
    assert.ok(entry.update.heading?.trim(), `${entry.id}: update has no heading`)
    assert.ok(entry.update.text?.trim(), `${entry.id}: update has no text`)
  }
})

test('the newest release has a short list of highlights, not a wall of text', () => {
  // These go into the update bar and the push notification, which have room for
  // a glance and no more. Older entries predate the field and are not held to it.
  const release = NEWS.find((e) => e.kind === 'release')
  assert.ok(Array.isArray(release.highlights), 'the newest release needs highlights')
  assert.ok(release.highlights.length >= 1 && release.highlights.length <= 3, 'one to three lines')
  for (const line of release.highlights) {
    assert.ok(line.trim().length > 0 && line.length <= 60, `too long (${line.length}): ${line}`)
    assert.doesNotMatch(line, /[—–]/, 'no dashes used as punctuation')
  }
})

test('cleanHighlights keeps up to three plain lines and drops anything else', () => {
  assert.deepEqual(cleanHighlights(['a', ' b ', 'c', 'd']), ['a', 'b', 'c'])
  assert.deepEqual(cleanHighlights(['a', '', '  ', 3, null, { x: 1 }]), ['a'])
  assert.equal(cleanHighlights(['x'.repeat(200)])[0].length, 80)
  for (const bad of [undefined, null, 'text', 5, {}]) assert.deepEqual(cleanHighlights(bad), [])
})

test('ids are unique', () => {
  const ids = NEWS.map((e) => e.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('newest first, so the banner shows the latest entry', () => {
  const dates = NEWS.map((e) => e.date)
  assert.deepEqual(dates, [...dates].sort().reverse())
  assert.equal(latestNews(), NEWS[0])
})

test('the newest release, APP_VERSION and package.json agree', () => {
  const release = NEWS.find((e) => e.kind === 'release')
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)))
  assert.equal(release.version, APP_VERSION)
  assert.equal(pkg.version, APP_VERSION)
})

test('closing remembers that id, and only that id', () => {
  const store = new Map()
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) }
  try {
    assert.equal(newsSeen('a'), false)
    markNewsSeen('a')
    assert.equal(newsSeen('a'), true)
    // A new entry has a new id, which is what brings the banner back.
    assert.equal(newsSeen('b'), false)
  } finally {
    delete globalThis.localStorage
  }
})

test('storage that throws reads as unseen, so the banner shows rather than crashing', () => {
  const boom = () => {
    throw new Error('blocked')
  }
  globalThis.localStorage = { getItem: boom, setItem: boom }
  try {
    assert.equal(newsSeen('a'), false)
    assert.doesNotThrow(() => markNewsSeen('a'))
  } finally {
    delete globalThis.localStorage
  }
})
