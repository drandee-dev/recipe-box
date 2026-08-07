// Week view for the meal plan. Presentational: App owns the plan rows, the
// week being shown and the store calls, and passes handlers down. The two
// swipe gestures here (remove a meal, change week) and the undo grace period
// are local UI state — App never learns about a removal until the undo
// window actually expires.
//
// A day lists only the slots it actually has something in, and an empty day
// collapses to one dashed row rather than a full card (findings 17, 18).

import { useEffect, useRef, useState } from 'react'
import RecipeThumb from './RecipeThumb.jsx'
import Sheet from './Sheet.jsx'
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

// Row swipe (finding 19). REVEAL is also the remove button's width, read off
// this constant rather than duplicated in CSS so the two can't drift.
const SWIPE_REVEAL = 72
const SWIPE_DELETE = 132
const SWIPE_OVERSHOOT = 40
const LONG_PRESS_MS = 500
const SWIPE_SLOP = 8
const UNDO_WINDOW_MS = 4500

// Week swipe (finding 20). Smaller threshold than the row's delete swipe —
// this gesture only has one outcome, not "reveal vs delete".
const WEEK_SWIPE_THRESHOLD = 56

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

  // Only one row's remove action is ever revealed at a time.
  const [openEntryId, setOpenEntryId] = useState(null)

  // The one in-flight "removed, can still undo" entry. A second removal while
  // this is showing flushes the first immediately rather than queueing a
  // second toast — one undo window at a time.
  const [pendingRemoval, setPendingRemoval] = useState(null)
  const pendingRef = useRef(null)
  const pendingTimeoutRef = useRef(null)
  useEffect(() => {
    pendingRef.current = pendingRemoval
  }, [pendingRemoval])

  // Switching tabs unmounts Planner (App.jsx only renders it while
  // tab === 'planner'). A dangling setTimeout would still fire into a stale
  // closure after that, so leaving mid-undo-window commits the removal
  // immediately instead — navigating away counts as confirming it.
  useEffect(() => {
    return () => {
      if (pendingRef.current) {
        clearTimeout(pendingTimeoutRef.current)
        onUnassign(pendingRef.current.entry.id)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A tap outside the open row's own swipe wrapper closes it. Bail while a
  // Sheet is open, same rule the pull gesture follows.
  useEffect(() => {
    if (!openEntryId) return
    function handleOutside(e) {
      if (document.querySelector('.sheet-backdrop')) return
      if (e.target.closest(`[data-entry-id="${openEntryId}"]`)) return
      setOpenEntryId(null)
    }
    document.addEventListener('pointerdown', handleOutside)
    return () => document.removeEventListener('pointerdown', handleOutside)
  }, [openEntryId])

  function handleEntryOpenChange(id, open) {
    setOpenEntryId((cur) => (open ? id : cur === id ? null : cur))
  }

  function removeEntry(entry, label) {
    if (pendingRef.current) {
      clearTimeout(pendingTimeoutRef.current)
      onUnassign(pendingRef.current.entry.id)
    }
    setOpenEntryId((cur) => (cur === entry.id ? null : cur))
    pendingTimeoutRef.current = setTimeout(() => {
      onUnassign(entry.id)
      setPendingRemoval((cur) => (cur && cur.entry.id === entry.id ? null : cur))
    }, UNDO_WINDOW_MS)
    setPendingRemoval({ entry, label })
  }

  function undoRemoval() {
    if (!pendingRemoval) return
    clearTimeout(pendingTimeoutRef.current)
    setPendingRemoval(null)
  }

  // Week swipe state. slideDir only drives the entrance animation of the new
  // week's content — the dragged-out old content isn't animated separately,
  // the key change below remounts straight into the new week.
  const [slideDir, setSlideDir] = useState(null)
  const [weekDragX, setWeekDragX] = useState(0)
  const [weekDragging, setWeekDragging] = useState(false)
  const weekGesture = useRef(null)
  const weekDragXRef = useRef(0)

  function goWeek(direction) {
    setSlideDir(direction > 0 ? 'right' : direction < 0 ? 'left' : null)
    onWeekChange(direction)
  }

  function setWeekDrag(x) {
    weekDragXRef.current = x
    setWeekDragX(x)
  }

  function handleWeekPointerDown(e) {
    if (e.target.closest('.planner-entry-swipe, button, a, input')) return
    weekGesture.current = { startX: e.clientX, startY: e.clientY, axis: null }
  }

  function handleWeekPointerMove(e) {
    const g = weekGesture.current
    if (!g) return
    const dx = e.clientX - g.startX
    const dy = e.clientY - g.startY
    if (g.axis === null) {
      if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
      if (g.axis === 'vertical') return
      setWeekDragging(true)
    }
    if (g.axis !== 'horizontal') return
    e.preventDefault()
    setWeekDrag(dx)
  }

  function endWeekGesture() {
    const g = weekGesture.current
    weekGesture.current = null
    if (g && g.axis === 'horizontal') {
      setWeekDragging(false)
      if (weekDragXRef.current <= -WEEK_SWIPE_THRESHOLD) {
        goWeek(1)
      } else if (weekDragXRef.current >= WEEK_SWIPE_THRESHOLD) {
        goWeek(-1)
      }
    }
    setWeekDrag(0)
  }

  const today = new Date()
  const days = weekDays(weekStart)
  const viewingThisWeek = days.some((d) => isSameDay(d, today))

  const byId = new Map(recipes.map((r) => [r.id, r]))

  // Escape, focus and the backdrop are Sheet's job now, not this component's.
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

  const weekBodyClass = [
    'planner-week-body',
    weekDragging && 'dragging',
    !weekDragging && slideDir === 'right' && 'planner-week-in-right',
    !weekDragging && slideDir === 'left' && 'planner-week-in-left',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="planner">
      <div className="planner-weeknav">
        <button
          type="button"
          className="btn btn-quiet btn-icon"
          onClick={() => goWeek(-1)}
          aria-label="Previous week"
        >
          ‹
        </button>
        <div className="planner-weeklabel">
          <button type="button" className="planner-weeklabel-btn" onClick={() => goWeek(0)}>
            {weekRangeLabel(weekStart)}
          </button>
          {!viewingThisWeek && (
            <button type="button" className="btn btn-quiet" onClick={() => goWeek(0)}>
              This week
            </button>
          )}
        </div>
        <button
          type="button"
          className="btn btn-quiet btn-icon"
          onClick={() => goWeek(1)}
          aria-label="Next week"
        >
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

      <div
        key={toISODate(weekStart)}
        className={weekBodyClass}
        style={weekDragging ? { transform: `translateX(${weekDragX}px)` } : undefined}
        onPointerDown={handleWeekPointerDown}
        onPointerMove={handleWeekPointerMove}
        onPointerUp={endWeekGesture}
        onPointerCancel={endWeekGesture}
      >
        {days.map((date) => {
          const dateISO = toISODate(date)
          const dayEntries = plan.filter(
            (e) => e.plan_date === dateISO && e.id !== pendingRemoval?.entry.id,
          )
          const isToday = isSameDay(date, today)
          const label = dayName(date)

          if (dayEntries.length === 0) {
            return (
              <button
                key={dateISO}
                type="button"
                className={
                  isToday
                    ? 'planner-day-collapsed planner-day-collapsed-today'
                    : 'planner-day-collapsed'
                }
                onClick={() => openPicker(date)}
                disabled={recipes.length === 0}
              >
                <span className="planner-day-collapsed-label">
                  {label}
                  <span className="planner-day-date">{shortDate(date)}</span>
                  {isToday && <span className="planner-today-pill">Today</span>}
                </span>
                <span className="planner-day-collapsed-cta">+ Add a meal</span>
              </button>
            )
          }

          return (
            <section
              key={dateISO}
              className={isToday ? 'planner-day planner-day-today' : 'planner-day'}
            >
              <div className="planner-day-head">
                <h3>
                  {label}
                  <span className="planner-day-date">{shortDate(date)}</span>
                  {/* The accent rule down the card's edge is decoration and
                      assistive tech never sees it, so today is also said in
                      words. */}
                  {isToday && <span className="planner-today-pill">Today</span>}
                </h3>
                <button
                  type="button"
                  className="btn btn-quiet btn-icon planner-day-add"
                  onClick={() => openPicker(date)}
                  disabled={recipes.length === 0}
                  aria-label={`Add a meal to ${label}`}
                >
                  +
                </button>
              </div>

              {SLOTS.filter((s) => dayEntries.some((e) => e.slot === s)).map((s) => (
                <div key={s} className="planner-slot">
                  <span className="planner-slot-label">{SLOT_LABELS[s]}</span>
                  <ul className="planner-entries">
                    {dayEntries
                      .filter((e) => e.slot === s)
                      .map((entry) => {
                        const recipe = byId.get(entry.recipe_id)
                        return (
                          <PlannerEntry
                            key={entry.id}
                            entry={entry}
                            recipe={recipe}
                            dayLabel={label}
                            isOpen={openEntryId === entry.id}
                            onOpenChange={(open) => handleEntryOpenChange(entry.id, open)}
                            onRemove={() => removeEntry(entry, label)}
                          />
                        )
                      })}
                  </ul>
                </div>
              ))}
            </section>
          )
        })}
      </div>

      {pendingRemoval && (
        <div className="planner-toast" role="status">
          <span>Removed from {pendingRemoval.label}</span>
          <button type="button" className="planner-toast-undo" onClick={undoRemoval}>
            Undo
          </button>
        </div>
      )}

      {picking && (
        <Sheet title={picking.dayLabel} onClose={() => setPicking(null)}>
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
              className="field planner-search"
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
                  {/* RecipeThumb rather than a bare <img>: these URLs expire and
                      get hotlink-blocked exactly as often here as they do on a
                      card, and a recipe with no photo used to leave the row with
                      no tile at all. */}
                  <RecipeThumb recipe={r} size="sm" />
                  <span>{r.title}</span>
                </button>
              </li>
            ))}
            {matches.length === 0 && (
              <li className="planner-pick-empty">No recipe matches that.</li>
            )}
          </ul>
        </Sheet>
      )}
    </div>
  )
}

// One planned meal. Swipe left reveals a Remove button (finding 19); dragging
// past SWIPE_DELETE removes it outright. A long press without much movement
// snaps straight to the revealed state — the "hold, then tap a real button"
// path for anyone who doesn't find (or can't perform) the drag. The Remove
// button is real and in the DOM at all times, so Tab reaches it regardless
// of where the row is sitting; focusing it reveals the row the same way a
// drag would, which is what makes it reachable by keyboard.
function PlannerEntry({ entry, recipe, dayLabel, isOpen, onOpenChange, onRemove }) {
  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const gesture = useRef(null)
  const dragXRef = useRef(0)

  useEffect(() => {
    if (!dragging) {
      const settled = isOpen ? -SWIPE_REVEAL : 0
      dragXRef.current = settled
      setDragX(settled)
    }
  }, [isOpen, dragging])

  function setDrag(x) {
    dragXRef.current = x
    setDragX(x)
  }

  function clearLongPress() {
    if (gesture.current?.longPressTimer) {
      clearTimeout(gesture.current.longPressTimer)
      gesture.current.longPressTimer = null
    }
  }

  function handlePointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const baseX = isOpen ? -SWIPE_REVEAL : 0
    gesture.current = { startX: e.clientX, startY: e.clientY, axis: null, baseX }
    gesture.current.longPressTimer = setTimeout(() => {
      if (gesture.current && gesture.current.axis === null) {
        gesture.current.axis = 'longpress'
        setDragging(false)
        setDrag(-SWIPE_REVEAL)
        onOpenChange(true)
      }
    }, LONG_PRESS_MS)
  }

  function handlePointerMove(e) {
    const g = gesture.current
    if (!g) return
    const dx = e.clientX - g.startX
    const dy = e.clientY - g.startY
    if (g.axis === null) {
      if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
      clearLongPress()
      if (g.axis === 'vertical') return
      setDragging(true)
    }
    if (g.axis !== 'horizontal') return
    e.preventDefault()
    const next = Math.min(0, Math.max(-SWIPE_DELETE - SWIPE_OVERSHOOT, g.baseX + dx))
    setDrag(next)
  }

  function handlePointerUp() {
    const g = gesture.current
    clearLongPress()
    gesture.current = null
    if (!g) return
    if (g.axis === 'horizontal') {
      setDragging(false)
      if (dragXRef.current <= -SWIPE_DELETE) {
        onRemove()
        return
      }
      onOpenChange(dragXRef.current <= -SWIPE_REVEAL / 2)
    } else if (g.axis === null && isOpen) {
      // A plain tap on an already-open row closes it.
      onOpenChange(false)
    }
  }

  function handlePointerCancel() {
    clearLongPress()
    gesture.current = null
    setDragging(false)
    setDrag(isOpen ? -SWIPE_REVEAL : 0)
  }

  return (
    <li className="planner-entry-swipe" data-entry-id={entry.id}>
      {/* The one filled-red surface in the app. Unlike .btn-danger this is
          never visible next to the day's own content — only one row's
          worth, revealed on purpose, at a time — so it doesn't compete with
          the accent the way a permanent red glyph on every row did. */}
      <button
        type="button"
        className="planner-entry-remove"
        style={{ width: SWIPE_REVEAL }}
        onClick={onRemove}
        onFocus={() => onOpenChange(true)}
        aria-label={`Remove ${recipe ? recipe.title : 'this meal'} from ${dayLabel}`}
      >
        Remove
      </button>
      <div
        className={dragging ? 'planner-entry-row dragging' : 'planner-entry-row'}
        style={{ transform: `translateX(${dragX}px)` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* A plan row can outlive its recipe if the recipe was deleted on
            another device before this one refetched. Show the gap rather
            than crashing. */}
        <span className={recipe ? '' : 'planner-entry-missing'}>
          {recipe ? recipe.title : 'Recipe no longer saved'}
        </span>
      </div>
    </li>
  )
}
