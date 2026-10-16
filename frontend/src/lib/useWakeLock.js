// Keeps the screen awake while the calling component is mounted.
//
// The single most common complaint about cooking from a phone. It shipped in
// Safari 16.4 but was broken in installed home-screen apps until iOS 18.4, so on a
// current iPhone this works and needs no fallback design.
//
// The load-bearing part is the re-acquire. The spec releases the lock whenever
// the page is hidden, so a version that requests once works perfectly until you
// glance at a text mid-cook, after which the screen sleeps again with nothing on
// screen having changed. Every call is wrapped: the device is allowed to refuse
// for low battery or a user setting, and the screen then simply sleeps.

import { useEffect } from 'react'

export function useWakeLock() {
  useEffect(() => {
    if (!navigator.wakeLock) return undefined
    let lock = null
    let cancelled = false

    async function acquire() {
      if (document.visibilityState !== 'visible') return
      try {
        lock = await navigator.wakeLock.request('screen')
        if (cancelled) {
          lock.release().catch(() => {})
          lock = null
        }
      } catch {
        lock = null
      }
    }

    function onVisible() {
      if (document.visibilityState === 'visible' && !lock) acquire()
    }

    acquire()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      lock?.release().catch(() => {})
    }
  }, [])
}
