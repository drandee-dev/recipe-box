// The app-level timers (A1). One provider at the top of the tree owns every
// running timer, so a timer started in cook mode is still there when cook mode
// closes, on the Planner tab, and after a reload.
//
// What it cannot do: a web page has no local scheduler, so nothing rings while
// the phone is locked or the app is in the background. When the page comes back
// into view an overdue timer rings at once. Ringing a locked phone needs a push
// from a server, which is A2.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { currentPushState, enablePush, mirrorTimers, resyncPush, unmirrorTimer } from './push.js'
import { ringUrl } from './ring.js'
import { MAX_TIMERS, isDue, loadTimers, makeTimer, saveTimers, sortTimers } from './timers.js'

// Whether the permission prompt has already been shown from a first Start. Kept
// so a dismissed prompt is not repeated on every timer; wrapped because storage
// can be blocked.
const ASKED_KEY = 'recipebox:pushAsked'
function readAsked() {
  try {
    return localStorage.getItem(ASKED_KEY) === '1'
  } catch {
    return false
  }
}
function markAsked() {
  try {
    localStorage.setItem(ASKED_KEY, '1')
  } catch {
    // Asked again next time, which is the lesser harm.
  }
}

// Any screen that wants to take you to a recipe (the tray's "Open recipe") says so
// with this event and App does the navigation. It is an event rather than a prop
// because the inline tray sits inside cook mode, inside the recipe sheet, three
// components away from the state that opens a recipe.
export const OPEN_RECIPE_EVENT = 'recipebox:open-recipe'

export function openRecipe(id) {
  window.dispatchEvent(new CustomEvent(OPEN_RECIPE_EVENT, { detail: id }))
}

// The fallback ring: three short tones out of an oscillator. The first choice is
// an audio element (lib/ring.js), which iOS plays over the silent switch; this
// is what runs if the element is refused.
function ring(ctx) {
  const start = ctx.currentTime
  for (let i = 0; i < 3; i += 1) {
    const at = start + i * 0.28
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    // Ramped rather than switched, because a square-edged gain change is a click.
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(0.2, at + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(at)
    osc.stop(at + 0.25)
  }
}

const TimersContext = createContext(null)

export function TimersProvider({ children }) {
  const [timers, setTimers] = useState(() => loadTimers())
  const [now, setNow] = useState(() => Date.now())
  const audioRef = useRef(null)
  const elementRef = useRef(null)

  useEffect(() => {
    saveTimers(timers)
  }, [timers])

  // Built inside a tap and nowhere else: that is the only moment iOS will unlock
  // audio, and a context that was unlocked stays unlocked for the ring minutes
  // later. `audioSession` asks iOS to play over the silent switch; it is a
  // one-line attempt that may not exist, and what it does on a real phone is
  // still to be checked.
  const unlockAudio = useCallback(() => {
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback'
    } catch {
      // Not available, or refused: the tone may then be muted by the ringer.
    }
    if (!audioRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (Ctx) {
        try {
          audioRef.current = new Ctx()
        } catch {
          audioRef.current = null
        }
      }
    }
    audioRef.current?.resume?.().catch(() => {})

    // The audio element is unlocked the same way: its first play() has to come
    // from this tap. Played muted and stopped at once, so there is no sound now
    // and the element is free to play for real when a timer comes due.
    if (!elementRef.current) {
      try {
        elementRef.current = new Audio(ringUrl())
        elementRef.current.preload = 'auto'
      } catch {
        elementRef.current = null
      }
      const el = elementRef.current
      if (el) {
        el.muted = true
        el.play()
          .then(() => {
            el.pause()
            el.currentTime = 0
          })
          .catch(() => {})
          .finally(() => {
            el.muted = false
          })
      }
    }
  }, [])

  // --- Lock-screen alerts (lib/push.js) ------------------------------------
  //
  // Mirrors are best effort and never block the in-page timer. `signedInRef` is
  // told by App (it owns the session) and read inside the Start tap, where
  // nothing may be awaited before the permission prompt is asked.
  const timersRef = useRef(timers)
  timersRef.current = timers
  const signedInRef = useRef(false)
  const [alerts, setAlerts] = useState(() => currentPushState(false))

  const setSignedIn = useCallback((signedIn) => {
    signedInRef.current = signedIn
    setAlerts(currentPushState(signedIn))
    // On sign-in and on every app load with a session: repair a subscription that
    // never saved and give an unmirrored running timer another try.
    if (signedIn) resyncPush(timersRef.current)
  }, [])

  // From a tap only. Asks for permission (once, from the first Start; the Timers
  // list has a button for any later try), subscribes, and mirrors what is already
  // running so a timer started a moment before the answer is not left out.
  const turnOnAlerts = useCallback(() => {
    return enablePush(signedInRef.current).then((state) => {
      setAlerts(state)
      if (state === 'on') mirrorTimers(timersRef.current)
    })
  }, [])

  const start = useCallback(
    (spec) => {
      unlockAudio()
      const current = timersRef.current
      // The callers disable their buttons at the cap; this is the backstop.
      if (current.length >= MAX_TIMERS) return
      // Pressing the same step's duration twice must not run two clocks.
      if (spec.key && current.some((t) => t.key === spec.key)) return
      const timer = makeTimer(spec)
      setTimers((prev) => [...prev, timer])
      setNow(Date.now())

      // The permission prompt is only ever shown for a tap, and this is one. Asked
      // the first time only; a "no" is the phone's to undo, not ours to nag about.
      const state = currentPushState(signedInRef.current)
      if (state === 'on') {
        mirrorTimers([timer])
      } else if (state === 'ask' && !readAsked()) {
        markAsked()
        turnOnAlerts()
      }
    },
    [unlockAudio, turnOnAlerts],
  )

  const stop = useCallback((id) => {
    setTimers((prev) => prev.filter((t) => t.id !== id))
    unmirrorTimer(id)
  }, [])

  // Four times a second, so the seconds digit turns close to when it should. It
  // runs only while something is on the clock, and the first tick after the page
  // returns catches up on everything that came due while it was away.
  const active = timers.length > 0
  useEffect(() => {
    if (!active) return undefined
    const tick = () => setNow(Date.now())
    tick()
    const id = setInterval(tick, 250)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [active])

  // Ring each timer once as it comes due, including one found already overdue
  // after a reload or a wake. `rang` is stored with the timer, so reloading
  // doesn't ring it again, while the timer itself stays until dismissed.
  useEffect(() => {
    const fresh = timers.filter((t) => !t.rang && isDue(t, now))
    if (fresh.length === 0) return
    // A context that was suspended while the page was away has to be resumed
    // first. After a full reload there is no context at all (it can only be built
    // in a tap), so an overdue timer found then is silent and shows on screen.
    // The audio element first; if it is missing or refuses, the oscillator.
    const el = elementRef.current
    const ctx = audioRef.current
    const fallback = () => {
      if (!ctx) return
      Promise.resolve(ctx.resume?.())
        .catch(() => {})
        .then(() => ring(ctx))
        .catch(() => {
          // A refused or closed context is not a reason to lose the timer.
        })
    }
    if (el) {
      el.currentTime = 0
      el.play().catch(fallback)
    } else {
      fallback()
    }
    // Android only, and only once the page has had a tap, or Chrome logs an
    // intervention. On iOS the pulsing tray is the alert that is guaranteed.
    if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.([200, 100, 200, 100, 200])
    const ids = new Set(fresh.map((t) => t.id))
    setTimers((prev) => prev.map((t) => (ids.has(t.id) ? { ...t, rang: true } : t)))
    // Rung in the page, so it must not also arrive as a push a few seconds later.
    // Only when the page is actually in view: a hidden page that was somehow
    // still running is exactly the case the push exists for.
    if (document.visibilityState === 'visible') fresh.forEach((t) => unmirrorTimer(t.id))
  }, [timers, now])

  useEffect(
    () => () => {
      audioRef.current?.close().catch(() => {})
      const el = elementRef.current
      if (el) {
        el.pause()
        URL.revokeObjectURL(el.src)
      }
    },
    [],
  )

  // Whether the full list is open. It lives here because three places open it
  // (the header button, the tray, cook mode) and one component renders it.
  const [listOpen, setListOpen] = useState(false)

  const value = useMemo(
    () => ({
      timers: sortTimers(timers),
      now,
      start,
      stop,
      full: timers.length >= MAX_TIMERS,
      listOpen,
      setListOpen,
      alerts,
      setSignedIn,
      turnOnAlerts,
    }),
    [timers, now, start, stop, listOpen, alerts, setSignedIn, turnOnAlerts],
  )
  return <TimersContext.Provider value={value}>{children}</TimersContext.Provider>
}

export function useTimers() {
  const ctx = useContext(TimersContext)
  if (!ctx) throw new Error('useTimers needs a TimersProvider')
  return ctx
}
