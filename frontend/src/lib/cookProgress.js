// Where you were in a recipe: the cook-mode step and the ticked ingredients and
// steps (A1). It exists because closing the app mid-cook (a text, a pot to
// watch) used to put you back at step one with nothing ticked.
//
// This reverses the old rule that the recipe sheet keeps nothing between
// openings, so it is bounded: progress older than a cooking session is thrown
// away on read, because a tick left over from Tuesday's dinner is worse than no
// tick at all. Reaching Done in cook mode clears it.

const PREFIX = 'recipebox:cook:'

export const SESSION_MS = 12 * 3600 * 1000

function read(recipeId, storage, now) {
  try {
    const saved = JSON.parse(storage.getItem(PREFIX + recipeId) || 'null')
    if (!saved || !(now - saved.savedAt < SESSION_MS)) return null
    return saved
  } catch {
    return null
  }
}

const indices = (v) => (Array.isArray(v) ? v.filter((n) => Number.isInteger(n) && n >= 0) : [])

// `stepCount` bounds what comes back, so a recipe edited down to fewer steps
// since the save can't leave cook mode on a step that no longer exists.
export function loadProgress(recipeId, stepCount, storage = globalThis.localStorage, now = Date.now()) {
  const saved = read(recipeId, storage, now)
  if (!saved) return { step: 0, gathered: [], done: [] }
  const step = Number.isInteger(saved.step) ? Math.min(Math.max(0, saved.step), Math.max(0, stepCount - 1)) : 0
  return { step, gathered: indices(saved.gathered), done: indices(saved.done) }
}

// A partial update: cook mode writes `step`, the sheet writes the tick sets, and
// neither may erase the other's half.
export function saveProgress(recipeId, patch, storage = globalThis.localStorage, now = Date.now()) {
  try {
    const prev = read(recipeId, storage, now) || {}
    storage.setItem(PREFIX + recipeId, JSON.stringify({ ...prev, ...patch, savedAt: now }))
  } catch {
    // Progress just won't survive a reload.
  }
}

export function clearProgress(recipeId, storage = globalThis.localStorage) {
  try {
    storage.removeItem(PREFIX + recipeId)
  } catch {
    // Nothing to do.
  }
}
