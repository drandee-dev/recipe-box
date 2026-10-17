// The cooked log, read as numbers. One row per time a recipe was cooked
// (cook_log, or localStorage when signed out); everything shown about it comes
// from those rows: the count on a card, "last cooked", and the two sorts.
// Pure, so it is tested without a DOM.

import { shortDate } from './dates.js'

// Rows in, per-recipe facts out: { count, last } where `last` is the newest
// cooked_at as an ISO string. A row for a recipe that no longer exists is simply
// never looked up.
export function cookStats(rows) {
  const stats = new Map()
  for (const row of rows || []) {
    if (!row?.recipe_id || !row.cooked_at) continue
    const cur = stats.get(row.recipe_id)
    if (!cur) stats.set(row.recipe_id, { count: 1, last: row.cooked_at })
    else {
      cur.count += 1
      if (row.cooked_at > cur.last) cur.last = row.cooked_at
    }
  }
  return stats
}

export const SORT_MODES = ['recent', 'cooked', 'most', 'az']

export const SORT_LABELS = {
  recent: 'Newest saved',
  cooked: 'Recently cooked',
  most: 'Most cooked',
  az: 'A to Z',
}

const byNewestSaved = (a, b) => (b.created_at || '').localeCompare(a.created_at || '')

// A new array; the input is never reordered. "Recently cooked" puts what you have
// cooked first, newest first, then everything you have not, in saved order.
// "Most cooked" is the count, ties broken by the more recent cook, then by saved
// order, so the order is the same every time it is drawn.
export function sortRecipes(recipes, mode, stats) {
  const list = [...recipes]
  const stat = (r) => stats?.get(r.id)
  if (mode === 'az') {
    return list.sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }))
  }
  if (mode === 'cooked') {
    return list.sort((a, b) => {
      const x = stat(a)?.last
      const y = stat(b)?.last
      if (x && y) return y.localeCompare(x) || byNewestSaved(a, b)
      if (x) return -1
      if (y) return 1
      return byNewestSaved(a, b)
    })
  }
  if (mode === 'most') {
    return list.sort((a, b) => {
      const x = stat(a)
      const y = stat(b)
      return (
        (y?.count || 0) - (x?.count || 0) ||
        (y?.last || '').localeCompare(x?.last || '') ||
        byNewestSaved(a, b)
      )
    })
  }
  return list.sort(byNewestSaved)
}

// "Cooked 3 times, last Oct 12": null when never cooked, so the caller shows
// nothing rather than "Cooked 0 times".
export function cookedLabel(stat) {
  if (!stat || stat.count < 1) return null
  const times = stat.count === 1 ? 'once' : `${stat.count} times`
  const last = new Date(stat.last)
  return Number.isNaN(last.getTime()) ? `Cooked ${times}` : `Cooked ${times}, last ${shortDate(last)}`
}

// The short form for a grid cell, which has one line: "Cooked 3×".
export function cookedShort(stat) {
  if (!stat || stat.count < 1) return null
  return stat.count === 1 ? 'Cooked once' : `Cooked ${stat.count}×`
}
