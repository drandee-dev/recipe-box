// Cook mode (finding 13). One step per screen, on a dark ground, with the screen
// held awake.
//
// This is the screen the app is for. Everything before it is filing; this is the
// twenty minutes with the phone propped against the kettle and one dry finger.
// So the constraints are different from every other surface here: the type is
// set to be read at arm's length, the two controls are the size of a thumb that
// has just been washed, and nothing on it is a decision — you are past deciding.
//
// It is a `Sheet`, which is not obvious from looking at it. The repo rule is
// that everything modal is one, and the reasons hold here even though the
// clothes are unusual: it opens *over* the open recipe, which is exactly the
// stacking case `sheetCount` exists for; it needs Escape, the focus trap, the
// body scroll lock and focus returning to the button that opened it; and the
// `.sheet-backdrop` it renders is what makes every gesture listener in the app
// (pull-to-refresh, the planner swipes) stand down while it is up. Writing a
// second modal to get a dark full-screen panel would have meant reimplementing
// all of that to change a background colour. `.sheet-cook` is the whole skin.

import { useEffect, useRef, useState } from 'react'
import Sheet from './Sheet.jsx'
import { formatClock, parseDuration } from '../lib/cook.js'
import { scaleIngredientText } from '../lib/ingredients.js'

const SWIPE_SLOP = 8
const SWIPE_THRESHOLD = 60

// Spelled out, because at this size a numeral in the eyebrow competes with the
// "3 / 4" in the head and they are the same fact twice. Past twelve the word is
// longer than the thing it labels, so it falls back to the numeral.
const ORDINALS = [
  'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX',
  'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE',
]

function stepLabel(n) {
  return ORDINALS[n - 1] || String(n)
}

// Three short tones out of an oscillator rather than an audio file: no asset to
// ship, no fetch to fail, and nothing to go missing from the cache offline.
// iOS will only let a context make noise if it was created inside a gesture,
// which the Start press is — the ring itself happens minutes later, and a
// context that was already unlocked stays unlocked.
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

export default function CookMode({ recipe, servings, factor = 1, onClose }) {
  const steps = recipe.instructions || []
  const [index, setIndex] = useState(0)
  // { step, total, endsAt } — endsAt is a wall-clock instant, not a countdown
  // being decremented. A decremented counter drifts, and worse, it stops while
  // the tab is throttled in the background, so a timer started before you
  // answered a message would come back with minutes still owed on it.
  const [timer, setTimer] = useState(null)
  const [remaining, setRemaining] = useState(0)
  const [ringing, setRinging] = useState(false)
  const [showIngredients, setShowIngredients] = useState(false)

  const audioRef = useRef(null)
  const gesture = useRef(null)
  const bodyRef = useRef(null)

  const step = steps[index] || ''
  const duration = parseDuration(step)
  const atLast = index >= steps.length - 1

  // --- Wake lock ----------------------------------------------------------
  //
  // The single most common complaint about cooking from a phone. It shipped in
  // Safari 16.4 but was broken in installed home-screen apps until iOS 18.4, so
  // on a current iPhone this works and needs no fallback design.
  //
  // The load-bearing part is the re-acquire. The spec releases the lock whenever
  // the page is hidden, so a version that requests once works perfectly until
  // you glance at a text mid-cook, after which the screen sleeps again with
  // nothing on screen having changed. Every call is wrapped: the device is
  // allowed to refuse for low battery or a user setting, and cook mode still
  // works with the screen simply sleeping.
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

  // --- The timer ----------------------------------------------------------
  useEffect(() => {
    if (!timer || ringing) return undefined
    function tick() {
      const left = Math.round((timer.endsAt - Date.now()) / 1000)
      setRemaining(Math.max(0, left))
      if (left <= 0) {
        setRinging(true)
        try {
          if (audioRef.current) ring(audioRef.current)
        } catch {
          // A refused or closed context is not a reason to lose the timer.
        }
        // Android only. On iOS the visual state is the whole alert, which is
        // why the ringing chip is loud rather than a subtle tint.
        navigator.vibrate?.([200, 100, 200, 100, 200])
      }
    }
    tick()
    // Four times a second, so the seconds digit turns close to when it should
    // rather than up to a second late.
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [timer, ringing])

  useEffect(() => {
    return () => {
      audioRef.current?.close().catch(() => {})
    }
  }, [])

  function startTimer() {
    if (!duration) return
    if (!audioRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      // Created here and nowhere else: this function only ever runs from a tap,
      // and that is the only moment iOS will unlock audio.
      if (Ctx) {
        try {
          audioRef.current = new Ctx()
        } catch {
          audioRef.current = null
        }
      }
    }
    audioRef.current?.resume?.().catch(() => {})
    setRinging(false)
    setRemaining(duration.seconds)
    setTimer({ step: index, total: duration.seconds, endsAt: Date.now() + duration.seconds * 1000 })
  }

  function clearTimer() {
    setTimer(null)
    setRinging(false)
    setRemaining(0)
  }

  // --- Moving between steps -----------------------------------------------
  //
  // The timer deliberately survives this. You start a twenty-minute simmer and
  // then read ahead — a timer that died when you looked at the next step would
  // be worse than not offering one, because you would only find out at the end.
  // It shows as a compact bar above the buttons whenever you are not on the
  // step that owns it.
  function go(direction) {
    setIndex((n) => Math.min(steps.length - 1, Math.max(0, n + direction)))
    setShowIngredients(false)
    bodyRef.current?.scrollTo({ top: 0 })
  }

  // Same shape as the planner's two gestures (see Planner.jsx): track the start
  // point, decide horizontal-versus-vertical once movement clears a slop, and
  // only preventDefault after that decision, so a vertical drag still scrolls a
  // long step normally. `touch-action: pan-y` on the body is what actually
  // reserves the vertical axis for the browser.
  function onPointerDown(e) {
    if (e.target.closest('button, a, input')) return
    gesture.current = { startX: e.clientX, startY: e.clientY, axis: null }
  }

  function onPointerMove(e) {
    const g = gesture.current
    if (!g) return
    const dx = e.clientX - g.startX
    const dy = e.clientY - g.startY
    if (g.axis === null) {
      if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
    }
    if (g.axis !== 'horizontal') return
    e.preventDefault()
    g.dx = dx
  }

  function onPointerUp() {
    const g = gesture.current
    gesture.current = null
    if (!g || g.axis !== 'horizontal' || !g.dx) return
    if (g.dx <= -SWIPE_THRESHOLD) go(1)
    else if (g.dx >= SWIPE_THRESHOLD) go(-1)
  }

  const progress = steps.length > 1 ? ((index + 1) / steps.length) * 100 : 100

  return (
    <Sheet
      className="sheet-cook"
      title={recipe.title}
      closeLabel="Close"
      onClose={onClose}
      // The one sheet you use without looking at it. A downward brush past a
      // step, hands full, should not close the thing being cooked from.
      dismissible={false}
      action={
        <span className="cook-count" aria-label={`Step ${index + 1} of ${steps.length}`}>
          {index + 1} / {steps.length}
        </span>
      }
    >
      <div className="cook-rail" aria-hidden="true">
        <div className="cook-rail-fill" style={{ width: `${progress}%` }} />
      </div>

      <div
        className="cook-body"
        ref={bodyRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* Keyed by index so the whole block is replaced rather than mutated,
            which is what makes the live region announce the new step instead of
            a diff of the old one. */}
        <div key={index} className="cook-step-block" aria-live="polite">
          <p className="cook-eyebrow">Step {stepLabel(index + 1)}</p>
          <p className="cook-step">{step}</p>
        </div>

        {duration && (
          <div className="cook-timer">
            {timer && timer.step === index ? (
              <button
                type="button"
                className={ringing ? 'cook-chip cook-chip-ringing' : 'cook-chip cook-chip-running'}
                onClick={clearTimer}
              >
                <span className="cook-chip-clock">{ringing ? "Time's up" : formatClock(remaining)}</span>
                <span className="cook-chip-verb">{ringing ? 'Dismiss' : 'Stop'}</span>
              </button>
            ) : (
              <button type="button" className="cook-chip" onClick={startTimer}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                  <circle cx="12" cy="13" r="8" />
                  <path d="M12 9.5V13l2.5 1.5M9.5 2.5h5" />
                </svg>
                <span className="cook-chip-clock">Start {formatClock(duration.seconds)}</span>
              </button>
            )}
          </div>
        )}

        {/* The one thing you reliably need mid-step that is not on the step:
            how much of something. It is behind a press rather than always on
            screen because it is the exception, and it carries the scale you set
            in the recipe (finding 12) — which is the only place that scale has
            to reach once you are actually cooking. */}
        {recipe.ingredients?.length > 0 && (
          <div className="cook-peek">
            <button
              type="button"
              className="cook-peek-toggle"
              aria-expanded={showIngredients}
              onClick={() => setShowIngredients((v) => !v)}
            >
              {/* The underline is on this span rather than on the button,
                  because text-decoration is drawn by the element that declares
                  it and a descendant cannot switch it off — `text-decoration:
                  none` on the serving count did nothing and it sat underlined
                  as if it were part of the control's label. */}
              <span className="cook-peek-label">
                {showIngredients ? 'Hide ingredients' : 'Ingredients'}
              </span>
              {servings ? <span className="cook-peek-servings">{servings}</span> : null}
            </button>
            {showIngredients && (
              <ul className="cook-peek-list">
                {recipe.ingredients.map((ing, n) => (
                  <li key={n}>{scaleIngredientText(ing.raw, factor)}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {!atLast && (
          <div className="cook-next">
            <p className="cook-next-label">Next</p>
            <p className="cook-next-text">{steps[index + 1]}</p>
          </div>
        )}
      </div>

      {/* Still running, but you have moved off its step. */}
      {timer && timer.step !== index && (
        <button
          type="button"
          className={ringing ? 'cook-away cook-away-ringing' : 'cook-away'}
          onClick={ringing ? clearTimer : () => go(timer.step - index)}
        >
          <span>{ringing ? "Time's up on step " : 'Step '}{timer.step + 1}</span>
          <span className="cook-away-clock">{ringing ? 'Dismiss' : formatClock(remaining)}</span>
        </button>
      )}

      <div className="cook-actions">
        <button type="button" className="cook-back" onClick={() => go(-1)} disabled={index === 0}>
          Back
        </button>
        <button
          type="button"
          className="cook-next-btn"
          onClick={() => (atLast ? onClose() : go(1))}
        >
          {atLast ? 'Done' : 'Next step'}
        </button>
      </div>
    </Sheet>
  )
}
