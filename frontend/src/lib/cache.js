// Offline mirror of the cloud lists.
//
// Signed out, everything already lives in localStorage and there is nothing to
// mirror. Signed in, a read that can't reach Supabase currently empties the
// screen, and the moment the app is needed most — standing in a shop with one
// bar of signal, looking at the week's list — is exactly when that happens. So
// every successful cloud read writes a copy locally, and a read that fails
// falls back to the copy.
//
// This is a read mirror, not a write queue. A capture or a tick made offline
// still fails and rolls back. Queuing writes would mean replaying them later
// against rows that may have changed on another device, and quietly resolving
// that wrong is worse than being told the change didn't save.
//
// Not workbox runtime caching of the Supabase REST calls, which was the other
// option: those URLs carry auth and filter params, a cached response would be
// served to whoever asked next, and the service worker has no idea which of
// them is a list read versus a write.

const PREFIX = 'recipebox:cache:'

// Who was signed in last time. The mirror is keyed per user and `userId` isn't
// known until `getSession()` resolves, so without this there is no way to find
// the right rows at mount — which is the whole of audit item 14. Written when a
// session resolves, cleared on sign-out along with the rows themselves, so it
// can only ever point at a mirror that is still there.
const LAST_USER = 'recipebox:lastUser'

// Keyed by user so a second account signing in on the same phone never reads
// the first one's rows, and by week where the query is week-scoped.
export const cacheKeys = {
  recipes: (userId) => `recipes:${userId}`,
  plan: (userId, weekISO) => `plan:${userId}:${weekISO}`,
  shopping: (userId, weekISO) => `shopping:${userId}:${weekISO}`,
}

export function readCache(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return null
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

export function writeCache(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // Quota, or Safari private mode. A missing mirror is a worse offline
    // experience, not a broken app, so the read it came from still counts.
  }
}

// Wraps a cloud list read. `key` is null when there is nothing to mirror
// (signed out), which keeps the call sites free of that branch.
//
// `stale: true` means the rows came from the mirror and may be behind. The
// original error is re-thrown when there is no mirror to fall back on, so a
// first run with no network still reports what went wrong.
export async function withMirror(key, fetch) {
  if (!key) return { rows: await fetch(), stale: false }
  try {
    const rows = await fetch()
    writeCache(key, rows)
    return { rows, stale: false }
  } catch (err) {
    const cached = readCache(key)
    if (!cached) throw err
    return { rows: cached, stale: true }
  }
}

export function rememberUser(userId) {
  try {
    if (userId) localStorage.setItem(LAST_USER, userId)
    else localStorage.removeItem(LAST_USER)
  } catch {
    // No mirror to find later, which costs a slower first paint and nothing else.
  }
}

// The rows to paint before auth resolves (item 14). Returns [] rather than null
// so it can seed `useState` directly.
//
// This paints one user's recipes before we have confirmed the session is still
// theirs. That is not a new disclosure: the rows are already in this browser's
// localStorage and stay there until sign-out clears them, so anyone who can read
// this is someone who could already read the mirror. The load that follows
// replaces them either way.
export function seedRecipes() {
  try {
    const userId = localStorage.getItem(LAST_USER)
    if (!userId) return []
    return readCache(cacheKeys.recipes(userId)) || []
  } catch {
    return []
  }
}

// Called on sign-out. The keys are per-user so the next account can't read
// these, but leaving one person's recipes in another's browser storage is not
// something to do on purpose.
export function clearCache() {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(PREFIX))
    keys.forEach((k) => localStorage.removeItem(k))
    // Must go with them, or the next mount seeds from rows that were just
    // deleted and paints the signed-out user's recipes for a frame.
    localStorage.removeItem(LAST_USER)
  } catch {
    // Nothing to do if storage is unavailable; there is no mirror either.
  }
}
