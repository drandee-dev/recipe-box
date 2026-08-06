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

// Called on sign-out. The keys are per-user so the next account can't read
// these, but leaving one person's recipes in another's browser storage is not
// something to do on purpose.
export function clearCache() {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(PREFIX))
    keys.forEach((k) => localStorage.removeItem(k))
  } catch {
    // Nothing to do if storage is unavailable; there is no mirror either.
  }
}
