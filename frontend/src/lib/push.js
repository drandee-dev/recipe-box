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
