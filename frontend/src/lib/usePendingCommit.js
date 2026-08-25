import { useCallback, useEffect, useRef, useState } from 'react'

// The undo window, which existed twice in near-identical form: deleting a recipe
// in RecipeList and removing a planned meal in Planner. Both are destructive,
// both chose an undo window over a confirm dialog for the same reason — undo
// costs one tap and only when you were wrong, a dialog costs one every time you
// were right — and both got there by copying the other.
//
// What the shape has to get right is not the timer. It is the three ways a
// window ends other than by lapsing, and each of them was a bug fixed once per
// copy:
//
//   * A second removal while one is pending **flushes the first** rather than
//     queueing a second toast, because two toasts with two Undo buttons cannot
//     say which one they undo.
//   * Unmounting **commits**. Both callers are rendered only while their tab is
//     selected, so switching tabs unmounts them; a dangling setTimeout would
//     fire into a stale closure, and the alternative to committing is an item
//     that reappears on the next visit.
//   * Undo is a `clearTimeout`, never a re-insert. The caller never told its
//     parent anything, so there is no position or id to restore.
//
// The caller keeps the item out of its own rendered list while `pending` is set
// — that is what makes the removal look immediate while staying free to undo.
export const UNDO_WINDOW_MS = 4500

/**
 * @param commit  called with the pending item once the window closes for real.
 * @returns { pending, start, undo } — `start(item)` opens a window on `item`.
 */
export function usePendingCommit(commit, { windowMs = UNDO_WINDOW_MS } = {}) {
  const [pending, setPending] = useState(null)

  // Read by the unmount effect below, which must not re-run when `pending`
  // changes — re-running it would fire its cleanup, committing early.
  const pendingRef = useRef(null)
  const timeoutRef = useRef(null)
  useEffect(() => {
    pendingRef.current = pending
  }, [pending])

  // Same reason `Sheet` holds `onClose` in a ref: callers pass a fresh closure
  // every render, so depending on it directly would tear this effect down (and
  // commit) on any parent re-render.
  const commitRef = useRef(commit)
  useEffect(() => {
    commitRef.current = commit
  }, [commit])

  const flush = useCallback(() => {
    if (!pendingRef.current) return
    clearTimeout(timeoutRef.current)
    commitRef.current(pendingRef.current)
    pendingRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      if (pendingRef.current) {
        clearTimeout(timeoutRef.current)
        commitRef.current(pendingRef.current)
      }
    }
  }, [])

  const start = useCallback(
    (item) => {
      flush()
      timeoutRef.current = setTimeout(() => {
        commitRef.current(item)
        // Only clear if this is still the window we opened — a later start()
        // may already have replaced it.
        setPending((cur) => (cur === item ? null : cur))
      }, windowMs)
      setPending(item)
    },
    [flush, windowMs],
  )

  const undo = useCallback(() => {
    clearTimeout(timeoutRef.current)
    pendingRef.current = null
    setPending(null)
  }, [])

  return { pending, start, undo }
}
