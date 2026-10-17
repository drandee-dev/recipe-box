// The open recipe (findings 10, 11, 14, 15, 16).
//
// It used to expand in place inside its card: the card grew to roughly 1,100px,
// pushed every other recipe off the bottom, and collapsing it dropped you
// somewhere other than where you had been reading. It is a sheet now, so the
// list keeps its scroll position and the recipe gets the whole screen instead of
// a card-width column.
//
// Most of what is held here is per-opening and deliberately not stored: whether
// the overflow is open, a half-filled plan slot, the serving scale. The sheet
// unmounts on close, which clears all of it. The exception is which ingredients
// you have gathered and which steps you have done: those are kept for twelve
// hours (lib/cookProgress.js), because losing them to a text message mid-cook is
// the failure, while a tick left over from Tuesday's cook is worse than no tick,
// hence the limit.

import { Fragment, useEffect, useRef, useState } from 'react'
import CookMode from './CookMode.jsx'
import RecipeThumb from './RecipeThumb.jsx'
import Sheet from './Sheet.jsx'
import StepText from './StepText.jsx'
import { loadProgress, saveProgress } from '../lib/cookProgress.js'
import { useWakeLock } from '../lib/useWakeLock.js'
import { SERVINGS_MAX_FACTOR, baseServings, hostOf, metaParts, servingsLabel } from '../lib/recipes.js'
import UnitsToggle from './UnitsToggle.jsx'
import { displayIngredient } from '../lib/convert.js'
import { qtyColumnCh } from '../lib/ingredients.js'
import IngredientLine from './IngredientLine.jsx'
import { useUnits } from '../lib/useUnits.js'
import { SLOTS, addDays, dayName, shortDate, toISODate } from '../lib/dates.js'

const SLOT_LABELS = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
}

// Seven days from today, not the planner's Sunday week. "Add this to the plan"
// is asked about the days ahead of you; a Sunday-anchored week would offer
// yesterday on a Wednesday and hide next Monday all week.
const PLAN_DAYS = 7


function planDayLabel(date, offset) {
  if (offset === 0) return 'Today'
  if (offset === 1) return 'Tomorrow'
  return dayName(date)
}

// The overflow behind the ⋯. It holds the two actions that are neither state nor
// the common case: opening the original page, and deleting. Delete is in here
// rather than in the row of buttons because it was previously one tap away from
// Edit with nothing between them.
function OverflowMenu({ recipe, onEdit, onDelete, onClose }) {
  const menuRef = useRef(null)

  useEffect(() => {
    // Opened from the keyboard, the first item is where you meant to be. Sheet's
    // trap already includes these, so Tab and Shift+Tab work from here either
    // way; this is only about not making you walk to them.
    menuRef.current?.querySelector('a, button')?.focus()
  }, [])

  useEffect(() => {
    // Capture phase, and it stops propagation: Sheet listens for Escape on
    // document in the bubble phase, so without this the first Escape would
    // close the whole recipe rather than the menu sitting on top of it.
    function onKey(e) {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    function onOutside(e) {
      if (menuRef.current?.contains(e.target)) return
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onOutside)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onOutside)
    }
  }, [onClose])

  // A disclosure, not `role="menu"`. A real menu promises arrow-key navigation
  // and roving tabindex; two items in a popover get neither, and claiming the
  // role without implementing it is worse for a screen reader than a plain group
  // of links and buttons that Tab already reaches.
  return (
    <div className="detail-menu-pop" ref={menuRef}>
      <button
        type="button"
        className="detail-menu-item"
        onClick={() => {
          onClose()
          onEdit(recipe)
        }}
      >
        Edit recipe
      </button>
      {recipe.source_url && (
        <a
          className="detail-menu-item"
          href={recipe.source_url}
          target="_blank"
          rel="noreferrer"
          onClick={onClose}
        >
          View source
        </a>
      )}
      <button
        type="button"
        className="detail-menu-item detail-menu-danger"
        onClick={() => {
          onClose()
          onDelete()
        }}
      >
        Delete recipe
      </button>
    </div>
  )
}

export default function RecipeDetail({
  recipe,
  onClose,
  onEdit,
  onDelete,
  onToggleFavorite,
  onAssign,
  onToList,
}) {
  // Sets of indices. Ingredients are a gathering list, steps are a progress
  // marker, and they are separate because ticking off the flour has nothing to
  // do with having finished step three.
  //
  // They come back if you were cooking in the last twelve hours (lib/cookProgress),
  // so a text or a locked phone doesn't cost you your place.
  const [saved] = useState(() => loadProgress(recipe.id, recipe.instructions.length))
  const [gathered, setGathered] = useState(() => new Set(saved.gathered))
  const [done, setDone] = useState(() => new Set(saved.done))
  const [menuOpen, setMenuOpen] = useState(false)

  const [planOpen, setPlanOpen] = useState(false)
  const [planDate, setPlanDate] = useState(() => toISODate(new Date()))
  const [planSlot, setPlanSlot] = useState('dinner')
  const [planned, setPlanned] = useState(null)

  // "To list": put some of this recipe's ingredients on the shopping list without
  // planning a meal. Which lines are chosen is held by index, and starts as every
  // line you have not already ticked off as gathered.
  const [listOpen, setListOpen] = useState(false)
  const [listPicked, setListPicked] = useState(() => new Set())
  const [listSending, setListSending] = useState(false)
  const [listed, setListed] = useState(null)

  const [cooking, setCooking] = useState(false)

  // Held for as long as the recipe is open, not only in cook mode: reading a
  // recipe off a phone propped on the counter is the same job. Paprika buries
  // this in a setting and people complain about it.
  useWakeLock()

  // The scaler (finding 12). Like everything else in this sheet it is per
  // opening and unstored: a recipe you cooked double for six people once is not
  // a recipe for six, and the number the recipe itself claims is the one that
  // should be there when you come back to it.
  //
  // No parsable serving count means no stepper at all. There is nothing
  // dishonest about a recipe that says "serves a crowd", and a stepper anchored
  // to a number nobody wrote would be inventing the thing this feature is
  // careful not to invent.
  const base = baseServings(recipe)
  const [servings, setServings] = useState(base)

  // Starts as the standing setting (account sheet) and can be flipped for this
  // one recipe without changing it. Per opening and unstored, like the scale.
  const standingUnits = useUnits()
  const [units, setLocalUnits] = useState(standingUnits)
  const factor = base && servings ? servings / base : 1

  const today = new Date()
  const planDays = Array.from({ length: PLAN_DAYS }, (_, i) => addDays(today, i))

  // The step you are on: the first not ticked. Derived, so ticking moves it and
  // nothing else has to be kept in step. -1 once every step is ticked.
  const currentStep = recipe.instructions.findIndex((_, n) => !done.has(n))

  // The lines as shown (scaled, in the chosen units) and the width of the one
  // quantity column they share. Both lists on this sheet use the same two.
  const ingLines = recipe.ingredients.map((ing) => displayIngredient(ing.raw, { factor, units }))
  const qtyCh = qtyColumnCh(ingLines)

  const host = hostOf(recipe.source_url)
  const tags = recipe.tags || []
  const empty = recipe.ingredients.length === 0 && recipe.instructions.length === 0

  // Saved from the handler, not an effect: an effect would also run on open and
  // refresh the saved time of progress you never touched.
  function toggle(kind, index) {
    const [current, setter] = kind === 'gathered' ? [gathered, setGathered] : [done, setDone]
    const next = new Set(current)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    setter(next)
    saveProgress(recipe.id, { [kind]: [...next] })
  }

  // What the chosen day is called, used by both the commit button and the
  // confirmation after it, so the two can't describe the same choice differently.
  const chosenOffset = planDays.findIndex((d) => toISODate(d) === planDate)
  const chosenLabel = chosenOffset >= 0 ? planDayLabel(planDays[chosenOffset], chosenOffset) : planDate

  function stepServings(by) {
    setServings((n) => Math.max(1, Math.min(Math.round(base * SERVINGS_MAX_FACTOR), n + by)))
  }

  function addToPlan() {
    // A recipe scaled on this sheet is planned at that scale: the stepper says
    // how many you are cooking for, and the shopping list should buy for it.
    // Untouched, it is null, which means "as the recipe says".
    onAssign(recipe.id, planDate, planSlot, factor !== 1 ? servings : null)
    setPlanned(`${chosenLabel} ${SLOT_LABELS[planSlot].toLowerCase()}`)
    setPlanOpen(false)
  }

  function openList() {
    setPlanOpen(false)
    setPlanned(null)
    setListed(null)
    if (!listOpen) {
      setListPicked(new Set(recipe.ingredients.map((_, n) => n).filter((n) => !gathered.has(n))))
    }
    setListOpen((v) => !v)
  }

  function toggleListed(n) {
    setListPicked((prev) => {
      const next = new Set(prev)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      return next
    })
  }

  // The lines go on as written on screen, scaled and in the units shown, since
  // that is what the person was looking at when they chose them.
  async function addToList() {
    const lines = recipe.ingredients
      .map((_, n) => (listPicked.has(n) ? ingLines[n] : null))
      .filter(Boolean)
    if (lines.length === 0 || listSending) return
    setListSending(true)
    try {
      const weekLabel = await onToList(recipe, lines)
      setListed(`${lines.length} ${lines.length === 1 ? 'line' : 'lines'} added to the list for ${weekLabel}.`)
      setListOpen(false)
    } catch {
      setListed("Couldn't add them. Try again.")
    } finally {
      setListSending(false)
    }
  }

  return (
    <Sheet
      className="sheet-tall"
      title={recipe.title}
      closeLabel="Close"
      onClose={onClose}
      action={
        <>
          {/* Favouriting is a state, not an action, so it reads as a star in the
              head rather than as a fourth button in a row of verbs. Saffron, by
              the palette rule: it says something is true about the recipe, it
              isn't something you are being asked to do. */}
          <button
            type="button"
            className={recipe.favorite ? 'detail-star detail-star-on' : 'detail-star'}
            aria-pressed={Boolean(recipe.favorite)}
            aria-label={recipe.favorite ? 'Remove from favourites' : 'Add to favourites'}
            onClick={() => onToggleFavorite(recipe)}
          >
            <span aria-hidden="true">{recipe.favorite ? '★' : '☆'}</span>
          </button>
          <span className="detail-menu">
            <button
              type="button"
              className="detail-more"
              aria-expanded={menuOpen}
              aria-label="More actions"
              // pointerdown with stopPropagation, not click. The open menu
              // dismisses itself on any pointerdown outside its own box, and
              // this button is outside it — so on a click handler, tapping ⋯ to
              // close would run the dismiss first, then toggle from the
              // already-false state and reopen. The menu could never be shut by
              // the control that opened it.
              onPointerDown={(e) => {
                e.stopPropagation()
                setMenuOpen((v) => !v)
              }}
            >
              <span aria-hidden="true">⋯</span>
            </button>
            {menuOpen && (
              <OverflowMenu recipe={recipe} onClose={() => setMenuOpen(false)} onEdit={onEdit} onDelete={onDelete} />
            )}
          </span>
        </>
      }
    >
      {/* Full bleed, so it reaches the sheet's edges rather than sitting in the
          text column with a margin down each side. Direction B is photo-led and
          this is the one place the photo is allowed to be big. */}
      <div className="detail-hero">
        <RecipeThumb recipe={recipe} size="hero" priority />
      </div>

      {/* Same dotted run the cell uses, with the source host on the end rather
          than on its own line — there is one of each fact and they are all the
          same kind of fact. The dot is a direct child of the flex row, not
          wrapped: it is sized as a flex item, so nesting it drops its width.
          `exact` is what keeps the real duration here: a grid cell replaces
          "12 hr" with "Overnight" because it has one line and that word is the
          answer, but by the time you have opened a recipe you want the number. */}
      <p className="detail-meta">
        {[...metaParts(recipe, { exact: true, servings: !base }), ...(host ? [host] : [])].map((part, n) => (
          <Fragment key={part}>
            {n > 0 && <span className="recipes-meta-dot" />}
            <span>{part}</span>
          </Fragment>
        ))}
      </p>

      {/* Read-only (finding 15). Every tag used to carry a remove cross and an
          "Add a tag" field sat open underneath, so reading a recipe put you one
          mistap from losing a tag. The editor owns tag changes now. */}
      {tags.length > 0 && (
        <p className="detail-tags">
          {tags.map((tag) => (
            <span key={tag} className="recipes-tag">
              {tag}
            </span>
          ))}
        </p>
      )}

      {/* The serving count moved out of the meta run and became this, which is
          why `metaParts` is asked to drop it above: the stepper *is* the serving
          count, and the two stated separately would disagree the moment you
          press +. Only rendered when there was a number to step from. */}
      {base !== null && (
        <div className="detail-servings">
          <button
            type="button"
            className="detail-serving-step"
            onClick={() => stepServings(-1)}
            disabled={servings <= 1}
            aria-label="One fewer serving"
          >
            <span aria-hidden="true">−</span>
          </button>
          {/* aria-live, because the ingredient quantities below change with it
              and nothing else announces that they have. */}
          <span className="detail-serving-count" aria-live="polite">
            {servingsLabel(recipe, servings)}
          </span>
          <button
            type="button"
            className="detail-serving-step"
            onClick={() => stepServings(1)}
            disabled={servings >= base * SERVINGS_MAX_FACTOR}
            aria-label="One more serving"
          >
            <span aria-hidden="true">+</span>
          </button>
          {factor !== 1 && (
            <button type="button" className="detail-serving-reset" onClick={() => setServings(base)}>
              Reset
            </button>
          )}
        </div>
      )}

      {/* Units for this recipe only. Beside the servings stepper because both change
          what the lines below say, and Original is the first choice so the recipe
          opens as it was written unless the person has asked otherwise. */}
      {recipe.ingredients.length > 0 && (
        <div className="detail-units">
          <UnitsToggle value={units} onChange={setLocalUnits} label="Measurements for this recipe" />
        </div>
      )}

      {/* The one verb this screen exists for, so it gets the width and the fill.
          It drops to secondary while the plan panel is open for the same reason
          Add to plan does — one filled accent per region. A recipe with no steps
          (a link card, or one still being filled in by hand) has nothing to cook
          from, and offering the button would open an empty screen. */}
      <div className="detail-actions">
        {/* One row, not a full-width button above a row of three: the ingredients
            are what a person came for and they were starting at y=709 of 844 at
            390px. Edit moved into the ⋯ menu to make the room. */}
        {recipe.instructions.length > 0 && (
          <button
            type="button"
            className={planOpen || listOpen ? 'btn btn-secondary' : 'btn btn-primary'}
            onClick={() => setCooking(true)}
          >
            Start cooking
          </button>
        )}
        {/* Secondary once the panel is open. It has become the disclosure that
            opened the thing, and the accent belongs on the one button that
            actually commits — one filled accent per region, or "how important is
            this" gets answered twice on the same screen. */}
        <button
          type="button"
          className={planOpen || recipe.instructions.length > 0 ? 'btn btn-secondary' : 'btn btn-primary'}
          aria-expanded={planOpen}
          onClick={() => {
            setPlanned(null)
            setListOpen(false)
            setPlanOpen((v) => !v)
          }}
        >
          Add to plan
        </button>
        {recipe.ingredients.length > 0 && (
          <button type="button" className="btn btn-secondary" aria-expanded={listOpen} onClick={openList}>
            To list
          </button>
        )}
      </div>

      {/* Inline rather than a second sheet stacked on this one. The recipe you
          are planning stays on screen, and it keeps the app to one modal at a
          time — the same reason "Write a recipe" swaps out of the capture sheet
          instead of opening on top of it. */}
      {planOpen && (
        <div className="detail-plan">
          <div className="detail-plan-days">
            {planDays.map((date, i) => {
              const iso = toISODate(date)
              const on = iso === planDate
              return (
                <button
                  key={iso}
                  type="button"
                  className={on ? 'planner-chip planner-chip-active' : 'planner-chip'}
                  aria-pressed={on}
                  onClick={() => setPlanDate(iso)}
                >
                  {planDayLabel(date, i)}
                  <span className="detail-plan-date">{shortDate(date)}</span>
                </button>
              )
            })}
          </div>
          <div className="detail-plan-slots">
            {SLOTS.map((s) => (
              <button
                key={s}
                type="button"
                className={s === planSlot ? 'planner-chip planner-chip-active' : 'planner-chip'}
                aria-pressed={s === planSlot}
                onClick={() => setPlanSlot(s)}
              >
                {SLOT_LABELS[s]}
              </button>
            ))}
          </div>
          {/* Names the choice rather than repeating the label of the button
              that opened it. Two controls reading "Add to plan" one above the
              other is a question about which one you meant. */}
          <button type="button" className="btn btn-primary btn-block" onClick={addToPlan}>
            Add to {chosenLabel} {SLOT_LABELS[planSlot].toLowerCase()}
          </button>
        </div>
      )}

      {listOpen && (
        <div className="detail-plan">
          <ul className="detail-tolist-lines">
            {recipe.ingredients.map((ing, n) => (
              <li key={n}>
                <label>
                  <input type="checkbox" checked={listPicked.has(n)} onChange={() => toggleListed(n)} />
                  <IngredientLine text={ingLines[n]} ch={qtyCh} />
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={listPicked.size === 0 || listSending}
            onClick={addToList}
          >
            {listPicked.size === 0
              ? 'Choose lines to add'
              : `Add ${listPicked.size} to this week's list`}
          </button>
        </div>
      )}

      {planned && (
        <p className="detail-planned" role="status">
          Added to {planned}.
        </p>
      )}
      {listed && (
        <p className="detail-planned" role="status">
          {listed}
        </p>
      )}

      {empty ? (
        <>
          {recipe.description && <p className="recipes-caption">{recipe.description}</p>}
          <p className="detail-meta">
            No recipe was readable from this post. Fill it in by hand with Edit recipe in the ⋯ menu, or open the
            source and paste the text into the + button's Paste recipe text.
          </p>
        </>
      ) : (
        <>
          <h3 className="detail-heading">Ingredients</h3>
          <ul className="detail-checks">
            {recipe.ingredients.map((ing, n) => (
              <li key={n} className={gathered.has(n) ? 'detail-check detail-check-on' : 'detail-check'}>
                <label>
                  <input
                    type="checkbox"
                    checked={gathered.has(n)}
                    onChange={() => toggle('gathered', n)}
                  />
                  {/* Scaled, but only where a quantity was actually found at
                      the head of this line. Anything else is the line as
                      written — the same rule the shopping list follows, and the
                      reason a scaled recipe can't produce a number the recipe
                      never gave. */}
                  <IngredientLine text={ingLines[n]} ch={qtyCh} />
                </label>
              </li>
            ))}
          </ul>

          <h3 className="detail-heading">Steps</h3>
          {recipe.instructions.length > 0 && (
            <p className="detail-awake">
              {navigator.wakeLock ? 'Screen stays on while this is open. ' : ''}
              Tap a time in a step to start a timer.
            </p>
          )}
          {/* Ingredients but no method is a normal import, not a failure: TikTok
              and Instagram creators routinely list what goes in and leave the
              how to the video. The `empty` branch above never catches it, so
              without this the heading sat over an empty list and the import
              looked broken. Say where the steps went and where to get them. */}
          {recipe.instructions.length === 0 ? (
            <p className="detail-meta">
              The source listed ingredients but no method, usually because the steps are only in
              the video. Add them with Edit recipe in the ⋯ menu, or paste them into the + button&rsquo;s Paste
              recipe text.
            </p>
          ) : (
            <ol className="detail-checks detail-steps">
              {recipe.instructions.map((step, n) => (
                <li
                  key={n}
                  aria-current={n === currentStep ? 'step' : undefined}
                  className={
                    done.has(n)
                      ? 'detail-check detail-check-on'
                      : n === currentStep
                        ? 'detail-check detail-check-current'
                        : 'detail-check'
                  }
                >
                  <label>
                    <input type="checkbox" checked={done.has(n)} onChange={() => toggle('done', n)} />
                    {/* The number is drawn rather than left to the <ol> marker,
                        because a marker sits outside the label and the whole row
                        has to be the tap target. */}
                    <span className="detail-step-n" aria-hidden="true">
                      {n + 1}
                    </span>
                    <span>
                      <StepText text={step} recipe={recipe} step={n} units={units} />
                    </span>
                  </label>
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      {/* Opens over this sheet rather than replacing it, so closing cook mode
          puts you back on the recipe you were reading. That is the stacking case
          `Sheet`'s depth counter exists for. */}
      {cooking && (
        <CookMode
          recipe={recipe}
          servings={base === null ? null : servingsLabel(recipe, servings)}
          factor={factor}
          units={units}
          onClose={() => setCooking(false)}
        />
      )}
    </Sheet>
  )
}
