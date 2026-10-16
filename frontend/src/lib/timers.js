// The timer tray's model (A1). Pure functions plus the one localStorage key, so
// the parts that fail quietly can be tested without a DOM.
//
// A timer is a wall-clock instant, never a counter being decremented: a counter
// drifts and stops while the page is throttled, so a timer started before you
// answered a message would come back owing minutes. Everything here is derived
// from `endsAt` and the current time.

const KEY = 'recipebox:timers'

// More than this at once is a pantry of egg timers, not a cook. It also bounds
// what a corrupt or hand-edited key can make the tray draw.
export const MAX_TIMERS = 8
export const MAX_SECONDS = 4 * 3600

export function makeTimer({ label, seconds, key = null, recipeId = null, recipeTitle = null, step = null }, now = Date.now()) {
  return {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    // What the chip pressed was called, e.g. "15 minutes", or a hand-typed name.
    label: String(label || '').slice(0, 60),
    total: seconds,
    endsAt: now + seconds * 1000,
    // Identifies the tappable duration in a step so its chip can show this
    // timer's clock, and so pressing it twice doesn't start two.
    key,
    recipeId,
    recipeTitle,
    step,
    // Set once the tone has played, so a reload doesn't ring it again. The timer
    // itself stays until dismissed: a ring you missed is still owed.
    rang: false,
  }
}

export function secondsLeft(timer, now = Date.now()) {
  return Math.max(0, Math.round((timer.endsAt - now) / 1000))
}

export function isDue(timer, now = Date.now()) {
  return timer.endsAt <= now
}

// Soonest first, so the tray's headline is always the one you are waiting on.
// One that has already rung has the earliest instant, so it leads: it is the one
// asking for you.
export function sortTimers(timers) {
  return [...timers].sort((a, b) => a.endsAt - b.endsAt)
}

function valid(t) {
  return (
    t &&
    typeof t.id === 'string' &&
    Number.isFinite(t.endsAt) &&
    Number.isFinite(t.total) &&
    t.total > 0 &&
    t.total <= MAX_SECONDS
  )
}

// Storage can be missing, full, or blocked (a private window throws on access),
// and what is in it can be anything. A timer that can't be read is dropped
// rather than allowed to take the tray down.
export function loadTimers(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(valid).slice(0, MAX_TIMERS)
  } catch {
    return []
  }
}

export function saveTimers(timers, storage = globalThis.localStorage) {
  try {
    if (timers.length === 0) storage.removeItem(KEY)
    else storage.setItem(KEY, JSON.stringify(timers))
  } catch {
    // Timers still work for this session; they just won't survive a reload.
  }
}

// Minutes and seconds from the manual form. A bare number is minutes, which is
// what anyone typing "10" into a timer means. Returns null for nothing usable.
export function manualSeconds(minutes, seconds = 0) {
  const total = Math.round(Number(minutes || 0) * 60 + Number(seconds || 0))
  if (!Number.isFinite(total) || total <= 0 || total > MAX_SECONDS) return null
  return total
}
