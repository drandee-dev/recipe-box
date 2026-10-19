// Timer alerts on a locked phone: the client half of A2 (the server half is
// backend/app/push.py).
//
// A running timer is mirrored to a `cook_timers` row so a server can fire it, and
// the phone's push address is saved in `push_subscriptions`. Everything here is
// best effort and silent on failure: the in-page timer works with or without it,
// and a push that cannot be set up must never break starting a timer.
//
// Needs, on iOS: the installed app (not Safari), iOS 18.4+ for the reliable
// Declarative Web Push, a signed-in user, and the user's yes to the permission
// prompt, which has to be asked from inside a tap.

import { getSupabase } from './supabase.js'
import { isIos, isStandalone } from './platform.js'

const PUBLIC_KEY = import.meta.env?.VITE_VAPID_PUBLIC_KEY || ''

// What to tell the user and what to do, from the facts. Pure, so it is tested.
//   unsupported  this browser has no web push
//   needs-install  iOS only delivers web push to the installed app
//   no-key       this build has no sender key (a build before release)
//   signed-out   timers are only mirrored for a signed-in user
//   denied       the user said no; only the phone's Settings can undo it
//   ask          not asked yet
//   on           alerts will arrive
export function pushState({ supported, ios, standalone, hasKey, signedIn, permission }) {
  if (!supported) return 'unsupported'
  if (ios && !standalone) return 'needs-install'
  if (!hasKey) return 'no-key'
  if (!signedIn) return 'signed-out'
  if (permission === 'denied') return 'denied'
  if (permission === 'granted') return 'on'
  return 'ask'
}

export function currentPushState(signedIn) {
  const supported =
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  return pushState({
    supported,
    ios: supported && isIos(),
    standalone: supported && isStandalone(),
    hasKey: Boolean(PUBLIC_KEY),
    signedIn,
    permission: supported ? Notification.permission : 'default',
  })
}

// The row the server fires from. `openUrl` is where the notification takes you:
// the app itself, at the recipe (App.jsx reads `?recipe=`).
export function timerRow(timer, origin) {
  return {
    client_id: timer.id,
    ends_at: new Date(timer.endsAt).toISOString(),
    label: timer.label || null,
    recipe_title: timer.recipeTitle || null,
    open_url: timer.recipeId ? `${origin}/?recipe=${encodeURIComponent(timer.recipeId)}` : `${origin}/`,
  }
}

// The applicationServerKey the browser wants is raw bytes; the key is stored as
// URL-safe base64.
export function urlBase64ToBytes(b64) {
  const padded = `${b64}${'='.repeat((4 - (b64.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

async function client() {
  const supabase = await getSupabase()
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  return data.session ? { supabase, userId: data.session.user.id } : null
}

// Make sure this phone's push address is saved for the signed-in user. Idempotent
// and never prompts, so it is safe to run on every sign-in and app load: the first
// save can fail (no session yet, offline), a second account can sign in on the
// same phone, and without this the state would read "on" with nowhere to send.
async function saveSubscription() {
  const registration = await navigator.serviceWorker.ready
  const sub =
    (await registration.pushManager.getSubscription()) ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(PUBLIC_KEY),
    }))
  const json = sub.toJSON()
  const ctx = await client()
  if (!ctx || !json.keys) return
  await ctx.supabase.from('push_subscriptions').upsert(
    {
      endpoint: json.endpoint,
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
      user_agent: navigator.userAgent.slice(0, 400),
    },
    { onConflict: 'user_id,endpoint' },
  )
}

// What the timer-alert note says for each push state. The timer list and the
// account sheet both show it, so the words are in one place.
export const ALERTS_TEXT = {
  on: 'Lock-screen alerts are on. A finished timer shows on your lock screen even if the app is closed.',
  ask: 'Get an alert on your lock screen when a timer finishes, even with the phone locked.',
  'needs-install': "To get alerts on a locked phone, add this app to your Home Screen from Safari's Share menu and open it from there.",
  'signed-out': 'Sign in to get alerts on your lock screen when a timer finishes.',
  denied: "Alerts are blocked. Turn on notifications for this app in the phone's Settings.",
}

// What the one-time notifications card offers, or null for nothing. Only inside
// the installed app (where the install card never shows, so the two cannot
// stack), only signed in, only once, and only for what can still be turned on:
// both when permission has not been asked, the new-versions switch alone when
// timer alerts are already on. `announce` is undefined until it has been read, so
// the card never flashes up for someone who already said yes.
export function notifyCardOffer({ state, announce, dismissed, standalone, signedIn, ready }) {
  if (!ready || dismissed || !signedIn || !standalone || announce === undefined) return null
  if (state === 'ask') return { timers: true, versions: true }
  if (state === 'on' && announce !== true) return { timers: false, versions: true }
  return null
}

// "Tell me about new versions" (the release announcement, backend/app/release.py).
// The switch is a column on this phone's own subscription row, separate from timer
// alerts: turning it off sets `announce` false and never deletes the row, because
// timers may still be using it, and saveSubscription never writes `announce`, so
// re-subscribing cannot switch someone back on. `origin` is written with the opt-in
// because staging and production share one database, and the server only announces
// to rows whose origin is the production app's.
//
// What the setting shows for a push state. Pure, so it is tested.
export function announceView(state) {
  const usable = state === 'ask' || state === 'on'
  const hints = {
    'needs-install': 'Add Recipe Box to your home screen first. An iPhone only delivers notifications to the installed app.',
    denied: "Notifications are blocked for Recipe Box. Turn them on in your phone's Settings, then come back here.",
    unsupported: "This browser can't show notifications.",
    'no-key': 'Not available in this version.',
    'signed-out': 'Sign in to turn this on.',
  }
  return {
    usable,
    hint:
      hints[state] ||
      'Sends one notification when a new version of Recipe Box is ready. It is separate from timer alerts. On an iPhone it needs iOS 18.4 or later.',
  }
}

// The one write behind the switch, with the client passed in so a test can see the
// real call. Matches by endpoint (this phone) and asks for the row back: RLS only
// lets a user touch their own rows, so zero rows back means nothing changed.
export async function applyAnnounce(supabase, endpoint, on, origin) {
  const patch = on ? { announce: true, origin } : { announce: false }
  const { data, error } = await supabase
    .from('push_subscriptions')
    .update(patch)
    .eq('endpoint', endpoint)
    .select('id')
  return !error && Array.isArray(data) && data.length === 1
}

async function thisPhone() {
  const registration = await navigator.serviceWorker.ready
  const sub = await registration.pushManager.getSubscription()
  const ctx = await client()
  return sub && ctx ? { endpoint: sub.endpoint, supabase: ctx.supabase } : null
}

// Called before sign-out, while the session can still write: the opt-in belongs to
// this phone's row under the account that made it, and signing out leaves that row
// behind. Without this the phone keeps getting the announcement after the person
// has gone, and whoever signs in next sees the switch Off and cannot turn it off
// (RLS hides the other account's row). Best effort and time-boxed: sign-out must
// never hang on a slow network or a browser with no worker.
export async function clearAnnounceForSignOut(ms = 1500) {
  const clear = (async () => {
    const phone = await thisPhone()
    if (phone) await applyAnnounce(phone.supabase, phone.endpoint, false)
  })().catch(() => {})
  await Promise.race([clear, new Promise((resolve) => setTimeout(resolve, ms))])
}

// Whether this phone is opted in. null when unknown (no subscription yet, signed
// out, offline), which the setting shows as off.
export async function readAnnounce() {
  try {
    const phone = await thisPhone()
    if (!phone) return null
    const { data } = await phone.supabase
      .from('push_subscriptions')
      .select('announce')
      .eq('endpoint', phone.endpoint)
      .maybeSingle()
    return data ? Boolean(data.announce) : null
  } catch {
    return null
  }
}

// Turn the switch. Turning on may have to ask for notification permission, so like
// enablePush it MUST be called straight from the tap, with nothing awaited first.
// Resolves to { state, announce }: the push state afterwards and whether the switch
// ended up on. A failure leaves the switch where it was.
export async function setAnnounce(on, signedIn, current) {
  const before = currentPushState(signedIn)
  try {
    if (on) {
      if (before !== 'ask' && before !== 'on') return { state: before, announce: false }
      if (before === 'ask') {
        const permission = await Notification.requestPermission()
        if (permission !== 'granted') return { state: currentPushState(signedIn), announce: false }
      }
      await saveSubscription()
    }
    const phone = await thisPhone()
    if (!phone) return { state: currentPushState(signedIn), announce: current }
    const ok = await applyAnnounce(phone.supabase, phone.endpoint, on, window.location.origin)
    return { state: currentPushState(signedIn), announce: ok ? on : current }
  } catch {
    return { state: currentPushState(signedIn), announce: current }
  }
}

// Ask for permission and subscribe. MUST be called synchronously from a tap:
// iOS only shows the permission prompt for a user gesture, so nothing may be
// awaited before `requestPermission`. Resolves to the new push state.
export async function enablePush(signedIn) {
  if (currentPushState(signedIn) !== 'ask' && currentPushState(signedIn) !== 'on') {
    return currentPushState(signedIn)
  }
  try {
    const permission = await Notification.requestPermission()
    if (permission === 'granted') await saveSubscription()
  } catch {
    // Not set up this time; the in-page timer is unaffected.
  }
  return currentPushState(signedIn)
}

// No prompt: only when alerts are already on. Saves the subscription again and
// mirrors whatever is running, which is also how a mirror that failed offline
// gets another chance.
export async function resyncPush(timers) {
  try {
    if (currentPushState(true) !== 'on') return
    await saveSubscription()
    await mirrorTimers(timers)
  } catch {
    // Best effort.
  }
}

// Only a timer still counting down is worth a push. One that already rang was
// deleted from the server on purpose (so it never alerts twice), and mirroring it
// again on the next app load would put it straight back with a past due time, for
// the cron to send as an alert for something the user already saw.
export function mirrorable(timers, now = Date.now()) {
  return timers.filter((t) => !t.rang && t.endsAt > now)
}

// Mirror running timers. Only once alerts are on: a signed-out or denied user
// has nothing to send to.
export async function mirrorTimers(timers) {
  try {
    const live = mirrorable(timers)
    if (currentPushState(true) !== 'on' || live.length === 0) return
    const ctx = await client()
    if (!ctx) return
    await ctx.supabase
      .from('cook_timers')
      .upsert(
        live.map((t) => timerRow(t, window.location.origin)),
        { onConflict: 'user_id,client_id', ignoreDuplicates: true },
      )
  } catch {
    // Best effort.
  }
}

// Forget a timer on the server: it was stopped, or it rang in the page and so
// must not ring again as a push.
export async function unmirrorTimer(clientId) {
  try {
    if (currentPushState(true) !== 'on') return
    const ctx = await client()
    if (!ctx) return
    await ctx.supabase.from('cook_timers').delete().eq('client_id', clientId)
  } catch {
    // Best effort.
  }
}
