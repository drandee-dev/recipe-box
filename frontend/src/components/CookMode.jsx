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

import { useMemo, useRef, useState } from 'react'
import Sheet from './Sheet.jsx'
import StepText from './StepText.jsx'
import { TimerTray } from './Timers.jsx'
import { clearProgress, loadProgress, saveProgress } from '../lib/cookProgress.js'
import { convertTemperatures, displayIngredient } from '../lib/convert.js'
import { qtyColumnCh } from '../lib/ingredients.js'
import { stepIngredientMap } from '../lib/stepIngredients.js'
import IngredientLine from './IngredientLine.jsx'
import { useWakeLock } from '../lib/useWakeLock.js'

const INGREDIENTS_KEY = 'recipebox:cookIngredients'

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

export default function CookMode({ recipe, servings, factor = 1, units = 'original', onFinished, onClose }) {
  const steps = recipe.instructions || []
  // Resumes where you left off if you were mid-cook in the last twelve hours.
  const [index, setIndex] = useState(() => loadProgress(recipe.id, steps.length).step)
  // The whole list is open by default where the step has nothing of its own to
  // show, and the choice is kept: closed, the middle of every step was empty
  // ground between a few lines of text and the Next preview (measured at
  // 390x844), and the ingredients are the thing you reach for mid-step. Where the
  // step does list its own (below), the whole list is behind a press instead,
  // since it is the scrolling that block exists to save. Once the person presses
  // it either way, that choice wins on every step, on this device. `null` is
  // "never chosen".
  const [choice, setChoice] = useState(() => {
    try {
      const saved = localStorage.getItem(INGREDIENTS_KEY)
      return saved === '1' || saved === '0' ? saved : null
    } catch {
      return null
    }
  })

  const gesture = useRef(null)
  const bodyRef = useRef(null)

  const step = steps[index] || ''
  const atLast = index >= steps.length - 1

  // What each step uses, worked out once per recipe (lib/stepIngredients).
  const stepMap = useMemo(() => stepIngredientMap(recipe), [recipe])
  const needs = stepMap[index] || []
  const showIngredients = choice === null ? needs.length === 0 : choice === '1'

  function toggleIngredients() {
    const next = showIngredients ? '0' : '1'
    setChoice(next)
    try {
      localStorage.setItem(INGREDIENTS_KEY, next)
    } catch {
      // Then it is back to the default next time. Not worth more.
    }
  }

  useWakeLock()

  // Timers live at the app level (lib/useTimers.jsx), so one started here is
  // still running when this closes, and the tray shows every one of them.

  // --- Moving between steps -----------------------------------------------
  //
  // Timers survive this: you start a twenty-minute simmer and then read ahead.
  function go(direction) {
    const next = Math.min(steps.length - 1, Math.max(0, index + direction))
    setIndex(next)
    saveProgress(recipe.id, { step: next })
    bodyRef.current?.scrollTo({ top: 0 })
  }

  // Reaching Done is the end of this cook: nothing is left to resume.
  function finish() {
    clearProgress(recipe.id)
    // Reaching Done is a cook: the recipe sheet logs it (cook_log).
    onFinished?.()
    onClose()
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

  // The peek list in one hanging quantity column, same as the recipe sheet.
  const ingLines = (recipe.ingredients || []).map((ing) => displayIngredient(ing.raw, { factor, units }))
  const qtyCh = qtyColumnCh(ingLines)
  const needsCh = qtyColumnCh(needs.map((m) => ingLines[m.index]))

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
            a diff of the old one. The announcement is a hidden plain copy: the
            visible step holds timer chips whose clocks change every second, and
            a live region over those would read out each tick. */}
        <div key={index} className="cook-step-block">
          <span className="rb-sr-only" aria-live="polite">
            Step {index + 1}. {step}
          </span>
          <p className="cook-eyebrow">Step {stepLabel(index + 1)}</p>
          <p className="cook-step">
            <StepText text={step} recipe={recipe} step={index} units={units} />
          </p>

          {/* How much of each thing this step uses, so the answer is on the step
              and not up a list. The lines are the recipe's own, at the scale you
              set. A step that names nothing shows nothing here. Where the same
              ingredient is listed under more than one section and the step does
              not say which, every candidate is shown with its section so the
              amounts can be told apart. */}
          {needs.length > 0 && (
            <div className="cook-needs">
              <p className="cook-needs-label">For this step</p>
              <ul className="cook-needs-list">
                {needs.map((m) => (
                  <li key={m.index}>
                    <IngredientLine text={ingLines[m.index]} ch={needsCh} />
                    {m.shared && m.group ? <span className="cook-needs-group">{m.group}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

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
              onClick={toggleIngredients}
            >
              {/* The underline is on this span rather than on the button,
                  because text-decoration is drawn by the element that declares
                  it and a descendant cannot switch it off — `text-decoration:
                  none` on the serving count did nothing and it sat underlined
                  as if it were part of the control's label. */}
              <span className="cook-peek-label">
                {showIngredients ? 'Hide ingredients' : needs.length > 0 ? 'All ingredients' : 'Ingredients'}
              </span>
              {servings ? <span className="cook-peek-servings">{servings}</span> : null}
            </button>
            {showIngredients && (
              <ul className="cook-peek-list">
                {recipe.ingredients.map((_, n) => (
                  <li key={n}>
                    <IngredientLine text={ingLines[n]} ch={qtyCh} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {!atLast && (
          <div className="cook-next">
            <p className="cook-next-label">Next</p>
            <p className="cook-next-text">{convertTemperatures(steps[index + 1], units)}</p>
          </div>
        )}
      </div>

      {/* Every running timer, above the buttons rather than over them. */}
      <TimerTray inline current={recipe.id} />

      <div className="cook-actions">
        <button type="button" className="cook-back" onClick={() => go(-1)} disabled={index === 0}>
          Back
        </button>
        <button
          type="button"
          className="cook-next-btn"
          onClick={() => (atLast ? finish() : go(1))}
        >
          {atLast ? 'Done' : 'Next step'}
        </button>
      </div>
    </Sheet>
  )
}
