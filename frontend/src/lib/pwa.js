// Service worker update handling.
//
// The generated registerSW.js binds registration to the window `load` event,
// which only fires on a real page load. An installed PWA is resumed rather
// than reloaded, so it never fired, never asked whether a newer sw.js existed,
// and kept serving the bundle it cached on install — indefinitely. That is why
// the installed app could show a login screen several builds older than the
// one in the browser. Registering the virtual module ourselves lets us check
// on resume instead of only at boot.
//
// registerType is 'prompt': a new worker installs and then WAITS, and the page
// is told (onNeedRefresh) so UpdateBar can offer a Reload. It was 'autoUpdate',
// where a worker that never finished taking over left an open app on the old
// build with nothing on screen to say so (reproduced by making push-sw.js fail
// once: the new worker sat waiting and stayed there until every window closed).
// Now a waiting worker is exactly the state that shows the bar.
//
// Reloading throws away a half-pasted recipe, so the bar's button is held while
// `busy` is set rather than the update being skipped.

import { registerSW } from 'virtual:pwa-register'
import { useSyncExternalStore } from 'react'
import { cleanHighlights } from './news.js'
import { writesInFlight } from './inflight.js'

const CHECK_INTERVAL = 60 * 60 * 1000

let busy = false
let ready = false
let dismissed = false
let highlights = []
let applyUpdate = null
let registration = null
let snapshot = { show: false, busy: false, highlights: [] }
const listeners = new Set()

function publish() {
  const next = { show: ready && !dismissed, busy, highlights }
  if (
    next.show === snapshot.show &&
    next.busy === snapshot.busy &&
    next.highlights === snapshot.highlights
  ) {
    return
  }
  snapshot = next
  listeners.forEach((l) => l())
}

// What the new build says changed, from the version.json the live site serves
// (emitted at build, see vite.config.js). The running code is the OLD build, so
// this is the only way it can show what the update holds. Best effort: no list is
// better than a wrong one, and the bar reads fine without it.
async function loadHighlights() {
  try {
    const resp = await fetch('/version.json', { cache: 'no-store' })
    if (!resp.ok) return
    highlights = cleanHighlights((await resp.json()).highlights)
    publish()
  } catch {
    /* the bar works without the list */
  }
}

// Called from App as capture work starts and finishes.
export function setBusy(value) {
  busy = value
  publish()
}

// "Later": hides the bar for this page load. The next launch finds the worker
// still waiting and asks again.
export function dismissUpdate() {
  dismissed = true
  publish()
}

export function applyPendingUpdate() {
  if (busy || !applyUpdate) return
  // Posts SKIP_WAITING to the waiting worker; the virtual module reloads the
  // page once it controls it.
  applyUpdate(true)
  // A worker whose importScripts('push-sw.js') failed at install is "waiting"
  // but never registered the message handler, so the line above does nothing
  // (reproduced). If the page is still here a moment later, drop the
  // registration and reload: a fresh install comes from the network.
  setTimeout(async () => {
    // Auto-update fired this on hide; if they came back and opened something in
    // these 3 s, leave it for the next hide rather than reloading over it.
    if (document.visibilityState === 'visible' && document.querySelector('.sheet-backdrop')) return
    try {
      await registration?.unregister()
    } catch {
      /* reload anyway */
    }
    location.reload()
  }, 3000)
}

// Auto-update (job 2): a waiting update is applied by itself when the app goes
// to the background with nothing in progress, so nobody has to press Reload; the
// bar stays for the foreground. "In progress" is a capture (`busy`), any open
// sheet (cook mode and the editor are sheets), a focused field with typing in
// it, a `data-draft` field holding text even unfocused (the shopping list's add
// box is not in a sheet), or a cloud save still on the wire.
export function quietForUpdate(doc = document, pendingWrites = writesInFlight()) {
  if (busy || !ready || !applyUpdate || pendingWrites > 0) return false
  if (doc.querySelector('.sheet-backdrop')) return false
  const el = doc.activeElement
  if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName) && el.value) return false
  if ([...doc.querySelectorAll('[data-draft]')].some((f) => f.value)) return false
  return true
}

function updateWhenHidden() {
  if (document.visibilityState === 'hidden' && quietForUpdate()) applyPendingUpdate()
}

// The new-version badge (push-sw.js) means "open me"; being open clears it.
function clearBadge() {
  if (document.visibilityState === 'visible') navigator.clearAppBadge?.().catch(() => {})
}

export function useUpdateReady() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => snapshot,
  )
}

export function initPwaUpdates() {
  clearBadge()
  document.addEventListener('visibilitychange', clearBadge)
  applyUpdate = registerSW({
    // Register now rather than on `load`, which a resumed app never fires.
    immediate: true,
    onNeedRefresh() {
      ready = true
      publish()
      loadHighlights()
    },
    onRegisteredSW(_swUrl, reg) {
      if (!reg) return
      registration = reg

      function check() {
        // Not gated on `busy`: finding a waiting worker reloads nothing now.
        if (document.visibilityState !== 'visible') return
        // Rejected when the browser is offline or the check is already in
        // flight. Neither is worth surfacing: the next resume tries again.
        reg.update().catch(() => {})
      }

      document.addEventListener('visibilitychange', check)
      document.addEventListener('visibilitychange', updateWhenHidden)
      window.addEventListener('focus', check)
      // Covers an installed app left open for days without ever backgrounding.
      setInterval(check, CHECK_INTERVAL)
    },
  })
}
