import test from 'node:test'
import assert from 'node:assert/strict'
import { announceView, applyAnnounce, clearAnnounceForSignOut, mirrorable, pushState, timerRow, urlBase64ToBytes } from './push.js'

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

test('the new-versions switch is usable only when notifications can be asked for or are on', () => {
  for (const state of ['ask', 'on']) assert.equal(announceView(state).usable, true)
  for (const state of ['needs-install', 'denied', 'unsupported', 'no-key', 'signed-out']) {
    const view = announceView(state)
    assert.equal(view.usable, false)
    assert.ok(view.hint.length > 0)
  }
  // Each blocked state says something different, so the person knows what to do.
  assert.notEqual(announceView('denied').hint, announceView('needs-install').hint)
})

// A fake client that records the real call chain applyAnnounce makes.
function fakeClient(result) {
  const calls = []
  const chain = {
    from: (table) => (calls.push(['from', table]), chain),
    update: (patch) => (calls.push(['update', patch]), chain),
    eq: (col, val) => (calls.push(['eq', col, val]), chain),
    select: (cols) => (calls.push(['select', cols]), Promise.resolve(result)),
  }
  return { client: chain, calls }
}

test('turning the switch on writes announce and the origin to this phone\'s row only', async () => {
  const { client, calls } = fakeClient({ data: [{ id: 's1' }], error: null })
  const ok = await applyAnnounce(client, 'https://push.example/x', true, 'https://app.example')
  assert.equal(ok, true)
  assert.deepEqual(calls, [
    ['from', 'push_subscriptions'],
    ['update', { announce: true, origin: 'https://app.example' }],
    ['eq', 'endpoint', 'https://push.example/x'],
    ['select', 'id'],
  ])
})

test('turning it off only clears announce: the row is kept and the origin is left alone', async () => {
  const { client, calls } = fakeClient({ data: [{ id: 's1' }], error: null })
  await applyAnnounce(client, 'https://push.example/x', false, 'https://app.example')
  assert.deepEqual(calls.find((c) => c[0] === 'update'), ['update', { announce: false }])
  assert.equal(calls.some((c) => c[0] === 'delete'), false)
})

test('a write that changed no row, or errored, is reported as not done', async () => {
  for (const result of [
    { data: [], error: null },
    { data: null, error: { message: 'x' } },
    { data: [{ id: 'a' }, { id: 'b' }], error: null },
  ]) {
    assert.equal(await applyAnnounce(fakeClient(result).client, 'e', true, 'o'), false)
  }
})

test('saving the subscription never touches announce', async () => {
  // Re-subscribing (every app load) must not switch someone back on. The upsert's
  // column list is what protects that, so read it out of the source.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('./push.js', import.meta.url), 'utf8')
  const upsert = source.match(/from\('push_subscriptions'\)\.upsert\(\s*\{([\s\S]*?)\},/)
  assert.ok(upsert, 'found the subscription upsert')
  assert.doesNotMatch(upsert[1], /announce|origin/)
})

test('clearing the opt-in at sign-out never blocks or throws without a worker', async () => {
  // In node there is no service worker, so thisPhone() rejects. Sign-out must
  // still go ahead.
  const started = Date.now()
  await clearAnnounceForSignOut(50)
  assert.ok(Date.now() - started < 1000)
})

test('sign-out clears the opt-in before it ends the session', async () => {
  // The write needs the session, so the order is the whole point.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../components/Account.jsx', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('async function signOut()'))
  const clear = body.indexOf('clearAnnounceForSignOut()')
  const end = body.indexOf('auth.signOut()')
  assert.ok(clear > 0 && end > 0, 'both calls are in signOut')
  assert.ok(clear < end)
})

test('urlBase64ToBytes decodes URL-safe base64 with and without padding', () => {
  // 0xfb 0xff 0xbe is "-_--" in URL-safe base64 ("+/++" in the standard one).
  assert.deepEqual([...urlBase64ToBytes('-_--')], [0xfb, 0xff, 0xbe])
  assert.deepEqual([...urlBase64ToBytes('QQ')], [0x41])
  assert.deepEqual([...urlBase64ToBytes('QQ==')], [0x41])
})
