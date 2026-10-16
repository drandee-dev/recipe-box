import test from 'node:test'
import assert from 'node:assert/strict'
import { mirrorable, pushState, timerRow, urlBase64ToBytes } from './push.js'

const ready = { supported: true, ios: true, standalone: true, hasKey: true, signedIn: true, permission: 'default' }

test('pushState walks the reasons alerts cannot work, most basic first', () => {
  assert.equal(pushState({ ...ready, supported: false }), 'unsupported')
  assert.equal(pushState({ ...ready, standalone: false }), 'needs-install')
  assert.equal(pushState({ ...ready, hasKey: false }), 'no-key')
  assert.equal(pushState({ ...ready, signedIn: false }), 'signed-out')
  assert.equal(pushState({ ...ready, permission: 'denied' }), 'denied')
  assert.equal(pushState(ready), 'ask')
  assert.equal(pushState({ ...ready, permission: 'granted' }), 'on')
})

test('only iOS needs the installed app; other browsers can use push in a tab', () => {
  assert.equal(pushState({ ...ready, ios: false, standalone: false }), 'ask')
})

test('an unsupported browser is reported as that even when everything else is off', () => {
  assert.equal(pushState({ supported: false, ios: false, standalone: false, hasKey: false, signedIn: false, permission: 'denied' }), 'unsupported')
})

test('timerRow carries the end instant and a link back into the app', () => {
  const row = timerRow(
    { id: 't1', label: '15 minutes', endsAt: Date.UTC(2026, 9, 16, 12, 0, 0), recipeId: 'r 1', recipeTitle: 'Chop Suey' },
    'https://recipe-box-coral.vercel.app',
  )
  assert.equal(row.client_id, 't1')
  assert.equal(row.ends_at, '2026-10-16T12:00:00.000Z')
  assert.equal(row.open_url, 'https://recipe-box-coral.vercel.app/?recipe=r%201')
  assert.equal(row.recipe_title, 'Chop Suey')
})

test('a timer added by hand links to the app and has no recipe title', () => {
  const row = timerRow({ id: 't2', label: '', endsAt: 0, recipeId: null, recipeTitle: null }, 'https://x.test')
  assert.equal(row.open_url, 'https://x.test/')
  assert.equal(row.label, null)
  assert.equal(row.recipe_title, null)
})

test('mirrorable leaves out a timer that already rang or is already due', () => {
  const now = 1_000_000
  const live = { id: 'a', endsAt: now + 5000, rang: false }
  const rang = { id: 'b', endsAt: now + 5000, rang: true }
  const pastDue = { id: 'c', endsAt: now - 1, rang: false }
  const exactlyNow = { id: 'd', endsAt: now, rang: false }
  assert.deepEqual(mirrorable([live, rang, pastDue, exactlyNow], now).map((t) => t.id), ['a'])
  assert.deepEqual(mirrorable([], now), [])
})

test('urlBase64ToBytes decodes URL-safe base64 with and without padding', () => {
  // 0xfb 0xff 0xbe is "-_--" in URL-safe base64 ("+/++" in the standard one).
  assert.deepEqual([...urlBase64ToBytes('-_--')], [0xfb, 0xff, 0xbe])
  assert.deepEqual([...urlBase64ToBytes('QQ')], [0x41])
  assert.deepEqual([...urlBase64ToBytes('QQ==')], [0x41])
})
