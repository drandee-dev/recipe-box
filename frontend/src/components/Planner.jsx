// Week view for the meal plan. Presentational: App owns the plan rows, the
// week being shown and the store calls, and passes handlers down.
//
// A day lists only the slots it actually has something in, with one Add button
// per day rather than one per slot. Four slots across seven days would be 28
// buttons on a phone screen, most of them empty most weeks.

import { useEffect, useRef, useState } from 'react'
import RecipeThumb from './RecipeThumb.jsx'
import {
  SLOTS,
  dayName,
  isSameDay,
  shortDate,
  toISODate,
  weekDays,
  weekRangeLabel,
} from '../lib/dates.js'

const SLOT_LABELS = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
}

export default function Planner({
  weekStart,
  plan,
  recipes,
  loading,
  onWeekChange,
  onAssign,
  onUnassign,
}) {
  // { dateISO, dayLabel } while the picker is open, null otherwise.
  const [picking, setPicking] = useState(null)
  const [slot, setSlot] = useState('dinner')
  const [query, setQuery] = useState('')
  const closeRef = useRef(null)

  const today = new Date()
  const days = weekDays(weekStart)
  const viewingThisWeek = days.some((d) => isSameDay(d, today))

  const byId = new Map(recipes.map((r) => [r.id, r]))

  // Escape closes the picker, and focus moves into it on open so the sheet is
  // reachable without a pointer.
  useEffect(() => {
    if (!picking) return
    closeRef.current?.focus()
    function onKey(e) {
      if (e.key === 'Escape') setPicking(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [picking])

  function openPicker(date) {
    setQuery('')
    setSlot('dinner')
    setPicking({ dateISO: toISODate(date), dayLabel: `${dayName(date)}, ${shortDate(date)}` })
  }

  function choose(recipeId) {
    onAssign(recipeId, picking.dateISO, slot)
    setPicking(null)
  }

  const matches = query.trim()
    ? recipes.filter((r) => r.title.toLowerCase().includes(query.trim().toLowerCase()))
    : recipes

  return (
    <div className="planner">
      <div className="planner-weeknav">
        <button
          className="planner-nav"
          onClick={() => onWeekChange(-1)}
          aria-label="Previous week"
        >
          ‹
        </button>
        <div className="planner-weeklabel">
          <strong>{weekRangeLabel(weekStart)}</strong>
          {!viewingThisWeek && (
            <button className="planner-thisweek" onClick={() => onWeekChange(0)}>
              This week
            </button>
          )}
        </div>
        <button className="planner-nav" onClick={() => onWeekChange(1)} aria-label="Next week">
          ›
        </button>
      </div>

      {recipes.length === 0 && !loading && (
        <p className="rb-empty">
          <strong>Nothing to plan with yet</strong>
          Save a recipe on the Recipes tab and it will show up here, ready to drop into
          a day.
        </p>
      )}

      {days.map((date) => {
        const dateISO = toISODate(date)
        const dayEntries = plan.filter((e) => e.plan_date === dateISO)
        const isToday = isSameDay(date, today)
        return (
          <section
            key={dateISO}
            className={isToday ? 'planner-day planner-day-today' : 'planner-day'}
          >
            <div className="planner-day-head">
              <h3>
                {dayName(date)}
                <span className="planner-day-date">{shortDate(date)}</span>
                {/* The accent rule down the card's edge is decoration and
                    assistive tech never sees it, so today is also said in
                    words. */}
                {isToday && <span className="planner-today-pill">Today</span>}
              </h3>
              <button
                className="planner-add"
                onClick={() => openPicker(date)}
                disabled={recipes.length === 0}
                aria-label={`Add a meal to ${dayName(date)}`}
              >
                Add
              </button>
            </div>

            {dayEntries.length === 0 ? (
              <p className="planner-day-empty">Nothing planned</p>
            ) : (
              SLOTS.filter((s) => dayEntries.some((e) => e.slot === s)).map((s) => (
                <div key={s} className="planner-slot">
                  <span className="planner-slot-label">{SLOT_LABELS[s]}</span>
                  <ul className="planner-entries">
                    {dayEntries
                      .filter((e) => e.slot === s)
                      .map((entry) => {
                        const recipe = byId.get(entry.recipe_id)
                        return (
                          <li key={entry.id} className="planner-entry">
                            {/* A plan row can outlive its recipe if the recipe
                                was deleted on another device before this one
                                refetched. Show the gap rather than crashing. */}
                            <span className={recipe ? '' : 'planner-entry-missing'}>
                              {recipe ? recipe.title : 'Recipe no longer saved'}
                            </span>
                            <button
                              className="planner-remove"
                              onClick={() => onUnassign(entry.id)}
                              aria-label={`Remove ${recipe ? recipe.title : 'this meal'} from ${dayName(date)}`}
                            >
                              ×
                            </button>
                          </li>
                        )
                      })}
                  </ul>
                </div>
              ))
            )}
          </section>
        )
      })}

      {picking && (
        <div className="planner-sheet-backdrop" onClick={() => setPicking(null)}>
          <div
            className="planner-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={`Add a meal to ${picking.dayLabel}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="planner-sheet-head">
              <strong>{picking.dayLabel}</strong>
              <button ref={closeRef} className="planner-sheet-close" onClick={() => setPicking(null)}>
                Cancel
              </button>
            </div>

            <div className="planner-slot-chips">
              {SLOTS.map((s) => (
                <button
                  key={s}
                  className={s === slot ? 'planner-chip planner-chip-active' : 'planner-chip'}
                  onClick={() => setSlot(s)}
                  aria-pressed={s === slot}
                >
                  {SLOT_LABELS[s]}
                </button>
              ))}
            </div>

            {recipes.length > 6 && (
              <input
                className="planner-search"
                type="search"
                placeholder="Search saved recipes"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}

            <ul className="planner-picklist">
              {matches.map((r) => (
                <li key={r.id}>
                  <button className="planner-pick" onClick={() => choose(r.id)}>
                    {/* RecipeThumb rather than a bare <img>: these URLs expire
                        and get hotlink-blocked exactly as often here as they do
                        on a card, and a recipe with no photo used to leave the
                        row with no tile at all. */}
                    <RecipeThumb recipe={r} size="sm" />
                    <span>{r.title}</span>
                  </button>
                </li>
              ))}
              {matches.length === 0 && (
                <li className="planner-pick-empty">No recipe matches that.</li>
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
