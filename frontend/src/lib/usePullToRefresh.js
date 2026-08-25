import { useEffect, useRef, useState } from 'react'

// Pull-to-refresh, and the foreground refetch that shares its job.
//
// Both exist because an installed PWA is *resumed, not reloaded*: the mount-time
// load in App never runs again, so a capture made in the browser stays invisible
// until something asks for the list a second time. These are the two things that
// ask. They were 140 lines in the middle of App.jsx and touch nothing else in
// it, which is what makes them liftable — everything below talks to the rest of
// the app through one callback.
//
// Four things about the feel are deliberate and easy to undo by accident:
//
//   * The damped curve `MAX * (1 - e^(-travel / DAMP))` rather than a multiplier
//     into a hard clamp. It is asymptotic, so the first pixels track the finger
//     almost exactly, it stiffens as you go, and it can never reach MAX. A clamp
//     is a wall you can feel.
//   * `PULL_SLOP` is finger travel spent before the gesture takes the touch at
//     all, and it is subtracted afterwards so nothing jumps at the moment of
//     capture. Without it one stray pixel at the top of the list committed to a
//     pull.
//   * `dragging` is tracked separately from `pull` so the indicator follows the
//     finger with **no** transition during the drag and animates only on release.
//   * `PULL_MIN_SPIN`, without which a signed-out refresh finishes inside a
//     frame and the gesture reads as having done nothing. It applies to the
//     gesture only — nobody is watching the resume-time refresh.
//
// The listeners are native with `{ passive: false }`, not React's `onTouchMove`,
// which React registers as passive so `preventDefault` is ignored and iOS
// rubber-bands instead. `overscroll-behavior-y: contain` on body is load-bearing
// for the same reason.
export const PULL_SLOP = 8
export const PULL_TRIGGER = 64
export const PULL_MAX = 90
export const PULL_DAMP = 88
export const PULL_MIN_SPIN = 550

export function pullDistance(travel) {
  return PULL_MAX * (1 - Math.exp(-travel / PULL_DAMP))
}

/**
 * @param onRefresh  async ({ gesture }) => void. Held in a ref, so a fresh
 *                   closure every render is fine and the listeners still bind once.
 * @param enabled    gate the foreground listeners until auth has settled — a
 *                   refetch before then would run against the wrong store.
 */
export function usePullToRefresh(onRefresh, { enabled = true } = {}) {
  const [pull, setPull] = useState(0)
  const [dragging, setDragging] = useState(false)
  const pullRef = useRef(0)

  const refreshRef = useRef(onRefresh)
  useEffect(() => {
    refreshRef.current = onRefresh
  }, [onRefresh])

  // Foreground refetch. visibilitychange covers resuming a standalone PWA and
  // unlocking the phone; focus covers desktop tab switches, where a background
  // tab stays "visible". pageshow catches a bfcache restore, which fires neither
  // of the other two. `online` covers coming back from the mirror — without it
  // the offline banner stays up until something else happens to trigger a
  // refetch, which in an app left open on the shopping tab may be nothing.
  useEffect(() => {
    if (!enabled) return undefined
    function onVisible() {
      if (document.visibilityState === 'visible') refreshRef.current()
    }
    function onPageShow(e) {
      if (e.persisted) refreshRef.current()
    }
    function onOnline() {
      refreshRef.current()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('online', onOnline)
    }
  }, [enabled])

  useEffect(() => {
    let startY = null
    // 'watching' means a touch began somewhere a pull could start from but has
    // not travelled far enough to be one yet; 'pulling' means it has, and from
    // then on the gesture owns the touch. Splitting them is what lets a normal
    // scroll or a tap survive an imprecise finger.
    let watching = false
    let pulling = false

    function reset() {
      watching = false
      pulling = false
      startY = null
      pullRef.current = 0
      setPull(0)
      setDragging(false)
    }

    function onStart(e) {
      if (e.touches.length !== 1 || window.scrollY > 0) return
      // A sheet covers the page and scrolls on its own. Dragging inside one
      // must not pull the list hidden behind it.
      if (document.querySelector('.sheet-backdrop')) return
      startY = e.touches[0].clientY
      watching = true
      pulling = false
    }

    function onMove(e) {
      if (!watching || startY === null) return
      // A second finger means a pinch or a two-finger scroll, neither of which
      // is this gesture.
      if (e.touches.length !== 1) {
        reset()
        return
      }
      const travel = e.touches[0].clientY - startY
      // Upward drag, or the page scrolled under us: hand the touch back so it
      // behaves as an ordinary scroll.
      if (travel <= 0 || window.scrollY > 0) {
        reset()
        return
      }
      if (!pulling) {
        if (travel < PULL_SLOP) return
        pulling = true
        setDragging(true)
      }
      e.preventDefault()
      const distance = pullDistance(travel - PULL_SLOP)
      pullRef.current = distance
      setPull(distance)
    }

    function onEnd() {
      if (!pulling) {
        reset()
        return
      }
      const distance = pullRef.current
      // Not a full reset: dragging goes false so the indicator animates to its
      // resting place, and pull goes to 0 so that place is either the parked
      // position (refreshing) or off-screen. Resetting the transform without
      // releasing the drag flag is what made the old one snap.
      watching = false
      pulling = false
      startY = null
      pullRef.current = 0
      setDragging(false)
      setPull(0)
      if (distance >= PULL_TRIGGER) refreshRef.current({ gesture: true })
    }

    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd)
    document.addEventListener('touchcancel', reset)
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', reset)
    }
  }, [])

  return { pull, dragging }
}
