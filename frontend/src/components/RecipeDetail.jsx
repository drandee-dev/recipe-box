// The open recipe (findings 10, 11, 14, 15, 16).
//
// It used to expand in place inside its card: the card grew to roughly 1,100px,
// pushed every other recipe off the bottom, and collapsing it dropped you
// somewhere other than where you had been reading. It is a sheet now, so the
// list keeps its scroll position and the recipe gets the whole screen instead of
// a card-width column.
//
// Everything held here is per-opening and deliberately not stored: which
// ingredients you have gathered, how far down the steps you are, whether the
// overflow is open, a half-filled plan slot. The sheet unmounts on close, which
// clears all of it. Nothing is saved, so nothing can go stale — a tick left over
// from Tuesday's cook is worse than no tick at all.

import { Fragment, useEffect, useRef, useState } from 'react'
import RecipeThumb from './RecipeThumb.jsx'
import Sheet from './Sheet.jsx'
import { hostOf, metaParts } from '../lib/recipes.js'
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
function OverflowMenu({ recipe, onDelete, onClose }) {
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
}) {
  // Sets of indices. Ingredients are a gathering list, steps are a progress
  // marker, and they are separate because ticking off the flour has nothing to
  // do with having finished step three.
  const [gathered, setGathered] = useState(() => new Set())
  const [done, setDone] = useState(() => new Set())
  const [menuOpen, setMenuOpen] = useState(false)

  const [planOpen, setPlanOpen] = useState(false)
  const [planDate, setPlanDate] = useState(() => toISODate(new Date()))
  const [planSlot, setPlanSlot] = useState('dinner')
  const [planned, setPlanned] = useState(null)

  const today = new Date()
  const planDays = Array.from({ length: PLAN_DAYS }, (_, i) => addDays(today, i))

  const host = hostOf(recipe.source_url)
  const tags = recipe.tags || []
  const empty = recipe.ingredients.length === 0 && recipe.instructions.length === 0

  function toggle(setter, index) {
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  // What the chosen day is called, used by both the commit button and the
  // confirmation after it, so the two can't describe the same choice differently.
  const chosenOffset = planDays.findIndex((d) => toISODate(d) === planDate)
  const chosenLabel = chosenOffset >= 0 ? planDayLabel(planDays[chosenOffset], chosenOffset) : planDate

  function addToPlan() {
    onAssign(recipe.id, planDate, planSlot)
    setPlanned(`${chosenLabel} ${SLOT_LABELS[planSlot].toLowerCase()}`)
    setPlanOpen(false)
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
              <OverflowMenu recipe={recipe} onClose={() => setMenuOpen(false)} onDelete={onDelete} />
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

      {/* Same dotted run the card uses, with the source host on the end rather
          than on its own line — there is one of each fact and they are all the
          same kind of fact. The dot is a direct child of the flex row, not
          wrapped: it is sized as a flex item, so nesting it drops its width. */}
      <p className="detail-meta">
        {[...metaParts(recipe), ...(host ? [host] : [])].map((part, n) => (
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

      <div className="detail-actions">
        {/* Secondary once the panel is open. It has become the disclosure that
            opened the thing, and the accent belongs on the one button that
            actually commits — one filled accent per region, or "how important is
            this" gets answered twice on the same screen. */}
        <button
          type="button"
          className={planOpen ? 'btn btn-secondary' : 'btn btn-primary'}
          aria-expanded={planOpen}
          onClick={() => {
            setPlanned(null)
            setPlanOpen((v) => !v)
          }}
        >
          Add to plan
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => onEdit(recipe)}>
          Edit
        </button>
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

      {planned && (
        <p className="detail-planned" role="status">
          Added to {planned}.
        </p>
      )}

      {empty ? (
        <>
          {recipe.description && <p className="recipes-caption">{recipe.description}</p>}
          <p className="detail-meta">
            No recipe was readable from this post. Fill it in by hand with Edit above, or open the
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
                    onChange={() => toggle(setGathered, n)}
                  />
                  <span>{ing.raw}</span>
                </label>
              </li>
            ))}
          </ul>

          <h3 className="detail-heading">Steps</h3>
          <ol className="detail-checks detail-steps">
            {recipe.instructions.map((step, n) => (
              <li key={n} className={done.has(n) ? 'detail-check detail-check-on' : 'detail-check'}>
                <label>
                  <input type="checkbox" checked={done.has(n)} onChange={() => toggle(setDone, n)} />
                  {/* The number is drawn rather than left to the <ol> marker,
                      because a marker sits outside the label and the whole row
                      has to be the tap target. */}
                  <span className="detail-step-n" aria-hidden="true">
                    {n + 1}
                  </span>
                  <span>{step}</span>
                </label>
              </li>
            ))}
          </ol>
        </>
      )}
    </Sheet>
  )
}
