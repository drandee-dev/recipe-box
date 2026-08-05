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
// registerType is 'autoUpdate', so a new worker skips waiting, claims the page
// and the virtual module reloads it. That reload is why checks are gated on
// `busy` below: reloading while someone is part-way through pasting a recipe
// would throw the text away. Skipping the check leaves the update pending, and
// the next idle resume takes it.

import { registerSW } from 'virtual:pwa-register'

const CHECK_INTERVAL = 60 * 60 * 1000

let busy = false

// Called from App as capture work starts and finishes.
export function setBusy(value) {
  busy = value
}

export function initPwaUpdates() {
  registerSW({
    // Register now rather than on `load`, which a resumed app never fires.
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return

      function check() {
        if (busy) return
        if (document.visibilityState !== 'visible') return
        // Rejected when the browser is offline or the check is already in
        // flight. Neither is worth surfacing: the next resume tries again.
        registration.update().catch(() => {})
      }

      document.addEventListener('visibilitychange', check)
      window.addEventListener('focus', check)
      // Covers an installed app left open for days without ever backgrounding.
      setInterval(check, CHECK_INTERVAL)
    },
  })
}
