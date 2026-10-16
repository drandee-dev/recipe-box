// The timer tray, the header button that opens the list, and the list itself
// with its add-by-hand form (A1).
//
// The tray shows the one timer you are waiting on (the soonest, or a ringing one)
// above the tab bar on every tab, so a timer started in cook mode is still
// visible after you leave it. Everything else is one tap away in the list.

import { useState } from 'react'
import Sheet from './Sheet.jsx'
import { formatClock } from '../lib/cook.js'
import { MAX_SECONDS, isDue, manualSeconds, secondsLeft } from '../lib/timers.js'
import { openRecipe, useTimers } from '../lib/useTimers.jsx'

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9.5V13l2.5 1.5M9.5 2.5h5" />
    </svg>
  )
}

function describe(timer) {
  return [timer.label || 'Timer', timer.recipeTitle].filter(Boolean).join(' · ')
}

// `inline` is cook mode's copy: in the flow above the Back and Next buttons
// rather than fixed to the screen, because a fixed tray there would sit on top of
// the two controls that screen exists for. The fixed one hides itself while cook
// mode is open (see `.rb-tray` in the stylesheet).
// "Open recipe" on a finished timer: acknowledges it (it stops asking for you),
// closes the list if that is where the press came from, and goes to the recipe.
function useOpenRecipe() {
  const { stop, setListOpen } = useTimers()
  return (timer) => {
    stop(timer.id)
    setListOpen(false)
    openRecipe(timer.recipeId)
  }
}

// `current` is the recipe already on screen under this tray, if any. A finished
// timer for that recipe has nowhere to take you, so it only offers Dismiss.
export function TimerTray({ inline = false, current = null }) {
  const { timers, now, stop, listOpen, setListOpen } = useTimers()
  const open = useOpenRecipe()
  // The fixed copy steps aside while the list is open: it would be drawn over
  // the list showing the same timer.
  if (timers.length === 0 || (!inline && listOpen)) return null

  const lead = timers[0]
  const due = isDue(lead, now)
  const more = timers.length - 1
  const canOpen = due && Boolean(lead.recipeId) && lead.recipeId !== current
  const cls = [
    'timer-tray',
    inline ? 'timer-tray-inline' : 'rb-tray',
    due ? 'timer-tray-ringing' : '',
    canOpen ? 'timer-tray-two' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls}>
      {/* Only the ring is announced. A live region on the clock would read out
          every second of every countdown. */}
      <span className="rb-sr-only" role="status">
        {due ? `Timer finished: ${describe(lead)}` : ''}
      </span>
      <button type="button" className="timer-tray-main" onClick={() => setListOpen(true)}>
        <ClockIcon />
        <span className="timer-tray-text">
          <span className="timer-tray-clock">{due ? "Time's up" : formatClock(secondsLeft(lead, now))}</span>
          <span className="timer-tray-label">
            {describe(lead)}
            {more > 0 ? ` · +${more} more` : ''}
          </span>
        </span>
      </button>
      {/* Both options on one row below the text, so each is a full-width target
          rather than two squeezed beside the clock. */}
      <div className={canOpen ? 'timer-tray-actions' : 'timer-tray-actions timer-tray-actions-one'}>
        {canOpen && (
          <button type="button" className="timer-tray-stop" onClick={() => open(lead)}>
            Open recipe
          </button>
        )}
        <button
          type="button"
          className="timer-tray-stop"
          aria-label={due ? 'Dismiss finished timer' : 'Stop this timer'}
          onClick={() => stop(lead.id)}
        >
          {due ? 'Dismiss' : 'Stop'}
        </button>
      </div>
    </div>
  )
}

export function TimersButton() {
  const { timers, setListOpen } = useTimers()
  const n = timers.length
  return (
    <button
      type="button"
      className="btn btn-quiet btn-icon rb-timers-btn"
      aria-label={n ? `Timers, ${n} running` : 'Timers'}
      onClick={() => setListOpen(true)}
    >
      <ClockIcon />
      {n > 0 && <span className="rb-timers-count" aria-hidden="true">{n}</span>}
    </button>
  )
}

export function TimersSheet() {
  const { timers, now, start, stop, full, listOpen, setListOpen } = useTimers()
  const open = useOpenRecipe()
  const [name, setName] = useState('')
  const [minutes, setMinutes] = useState('')
  const [error, setError] = useState('')

  if (!listOpen) return null

  function submit(e) {
    e.preventDefault()
    const seconds = manualSeconds(minutes)
    if (seconds === null) {
      setError(`Enter a number of minutes, up to ${MAX_SECONDS / 60}.`)
      return
    }
    start({ label: name.trim() || `${minutes} min`, seconds })
    setName('')
    setMinutes('')
    setError('')
  }

  return (
    <Sheet title="Timers" closeLabel="Done" onClose={() => setListOpen(false)}>
      {timers.length === 0 ? (
        <p className="timers-empty">
          Nothing running. Tap a time in a recipe's steps, or add one below.
        </p>
      ) : (
        <ul className="timers-list">
          {timers.map((t) => {
            const due = isDue(t, now)
            return (
              <li key={t.id} className={due ? 'timers-row timers-row-ringing' : 'timers-row'}>
                <span className="timers-row-text">
                  <span className="timers-row-clock">{due ? "Time's up" : formatClock(secondsLeft(t, now))}</span>
                  <span className="timers-row-label">{describe(t)}</span>
                </span>
                <span className="timers-row-actions">
                  {due && t.recipeId && (
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => open(t)}>
                      Open recipe
                    </button>
                  )}
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => stop(t.id)}>
                    {due ? 'Dismiss' : 'Stop'}
                  </button>
                </span>
              </li>
            )
          })}
        </ul>
      )}

      <form className="timers-add" onSubmit={submit}>
        <h3 className="detail-heading">Add a timer</h3>
        <div className="timers-add-fields">
          <input
            className="field"
            type="text"
            value={name}
            maxLength={60}
            placeholder="Name (optional)"
            aria-label="Timer name"
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="field timers-minutes"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={minutes}
            placeholder="Minutes"
            aria-label="Minutes"
            onChange={(e) => setMinutes(e.target.value)}
          />
        </div>
        {error && <p className="timers-error" role="alert">{error}</p>}
        {full && <p className="timers-error">That's the most timers at once. Stop one to add another.</p>}
        <button type="submit" className="btn btn-primary btn-block" disabled={full}>
          Start timer
        </button>
      </form>
    </Sheet>
  )
}
