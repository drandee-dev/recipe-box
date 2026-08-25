// The three bits of plumbing every store repeats.
//
// store.js, plan.js and shopping.js are deliberately the same shape: a
// localStorage backend, a Supabase backend, one `make*Store(userId)` picker, and
// a one-time upload on sign-in. That mirroring is worth keeping — each store's
// *differences* are the interesting part and they stay readable top to bottom.
// What was not worth keeping is three identical copies of `readLocal`, three of
// `writeLocal`, and fourteen of `if (error) throw new Error(error.message)`.
//
// So this file holds only the parts that were literally identical. Nothing here
// knows about recipes, plans or shopping items, and no store's own logic moved
// into it.

import { getSupabase, supabaseEnabled } from './supabase.js'

// A localStorage-backed array under one key. Reads never throw: a key holding
// something unparseable (a half-written value, a hand-edited devtools session)
// reads as empty rather than taking down the app on mount.
export function localRows(key) {
  return {
    key,
    read() {
      try {
        return JSON.parse(localStorage.getItem(key)) || []
      } catch {
        return []
      }
    },
    write(rows) {
      localStorage.setItem(key, JSON.stringify(rows))
    },
    clear() {
      localStorage.removeItem(key)
    },
  }
}

// PostgREST answers with `{ data, error }` rather than rejecting, so every call
// has to unwrap by hand and a forgotten check is a store that silently returns
// undefined instead of failing. `error.message` is the useful half; App's
// `humanMessage` is what decides whether it is fit to show anyone.
export function unwrap({ data, error }) {
  if (error) throw new Error(error.message)
  return data
}

// `await client()` in place of `await getSupabase()`, purely so a store file
// does not have to import two names to make one call.
export const client = getSupabase

// Signed out, or no cloud configured at all: localStorage is the source of
// truth, not a cache of one.
export function pickStore(userId, makeRemote, local) {
  return userId && supabaseEnabled ? makeRemote(userId) : local
}
