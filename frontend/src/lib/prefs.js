// Shopping list preferences: staples, the aisle you moved an item to, and your
// shop's aisle order. Same shape as the other stores (localStorage signed out,
// one Supabase row signed in, a one-time upload on sign-in), except the data is
// one object rather than a list of rows.
//
// These are display choices only. They decide where a line is shown and whether
// it is collapsed, and never touch a line's merge key (name|dimension), so the
// ticks stored in shopping_items mean the same thing with or without them.
//
// Items are named by their normalised name (`nameKey` on a shopping line, the
// part of the merge key before the "|"), so "Kosher salt" and "kosher salt" are
// one staple and "2 tsp" and "1 tbsp" of it are one line.

import { client, pickStore, unwrap } from './backend.js'
import { AISLE_ORDER } from './ingredients.js'

const KEY = 'recipebox:shopprefs'

// Mirrors the table's size check (supabase/schema.sql), so a client can't write a
// row the database would refuse and then wonder why nothing saved.
const MAX_STAPLES = 400
const MAX_MAPPED = 800
const MAX_NAME = 80

export const EMPTY_PREFS = Object.freeze({ staples: [], aisle_map: {}, aisle_order: [] })

const validName = (s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_NAME

// Anything read from storage or the network goes through here. Unknown aisles,
// oversize names and duplicates are dropped rather than trusted.
export function sanitizePrefs(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const staples = [...new Set((Array.isArray(src.staples) ? src.staples : []).filter(validName))]
  const aisle_map = {}
  const mapped = src.aisle_map && typeof src.aisle_map === 'object' ? Object.entries(src.aisle_map) : []
  for (const [name, aisle] of mapped) {
    if (Object.keys(aisle_map).length >= MAX_MAPPED) break
    if (validName(name) && AISLE_ORDER.includes(aisle)) aisle_map[name] = aisle
  }
  const aisle_order = [
    ...new Set((Array.isArray(src.aisle_order) ? src.aisle_order : []).filter((a) => AISLE_ORDER.includes(a))),
  ]
  return { staples: staples.slice(0, MAX_STAPLES), aisle_map, aisle_order }
}

// The order aisles are shown in: your order first, then any the saved order does
// not mention, in the built-in order. A prefs row written before an aisle existed
// therefore still shows every aisle.
export function effectiveAisleOrder(prefs) {
  const mine = prefs?.aisle_order || []
  return [...mine, ...AISLE_ORDER.filter((a) => !mine.includes(a))]
}

export function toggleStaple(prefs, nameKey) {
  const has = prefs.staples.includes(nameKey)
  if (!has && prefs.staples.length >= MAX_STAPLES) return prefs
  return {
    ...prefs,
    staples: has ? prefs.staples.filter((s) => s !== nameKey) : [...prefs.staples, nameKey],
  }
}

// Moving an item back to the aisle the keyword list would have chosen is
// forgetting the choice, not storing a second copy of the default.
export function setAisle(prefs, nameKey, aisle, defaultAisle) {
  const aisle_map = { ...prefs.aisle_map }
  if (!aisle || aisle === defaultAisle) delete aisle_map[nameKey]
  else if (AISLE_ORDER.includes(aisle) && (nameKey in aisle_map || Object.keys(aisle_map).length < MAX_MAPPED)) {
    aisle_map[nameKey] = aisle
  }
  return { ...prefs, aisle_map }
}

export function moveAisle(prefs, aisle, by) {
  const order = effectiveAisleOrder(prefs)
  const from = order.indexOf(aisle)
  const to = from + by
  if (from < 0 || to < 0 || to >= order.length) return prefs
  const next = [...order]
  next.splice(to, 0, next.splice(from, 1)[0])
  return { ...prefs, aisle_order: next }
}

const localStore = {
  async load() {
    try {
      return sanitizePrefs(JSON.parse(localStorage.getItem(KEY)))
    } catch {
      return sanitizePrefs(null)
    }
  },
  async save(prefs) {
    localStorage.setItem(KEY, JSON.stringify(sanitizePrefs(prefs)))
  },
}

function supabaseStore(userId) {
  return {
    async load() {
      const supabase = await client()
      const row = unwrap(await supabase
        .from('shopping_prefs')
        .select('staples,aisle_map,aisle_order')
        .eq('user_id', userId)
        .maybeSingle())
      return sanitizePrefs(row)
    },
    async save(prefs) {
      const supabase = await client()
      unwrap(await supabase
        .from('shopping_prefs')
        .upsert({ ...sanitizePrefs(prefs), user_id: userId, updated_at: new Date().toISOString() }))
    },
  }
}

// On sign-in, whatever was chosen signed out is merged into the account's row
// (the account's own choices win a clash) and the local copy is cleared.
export async function migrateLocalPrefs(userId) {
  let local
  try {
    local = JSON.parse(localStorage.getItem(KEY))
  } catch {
    local = null
  }
  if (!local) return false
  const mine = sanitizePrefs(local)
  const empty =
    mine.staples.length === 0 && mine.aisle_order.length === 0 && Object.keys(mine.aisle_map).length === 0
  if (!empty) {
    const remote = await supabaseStore(userId).load()
    await supabaseStore(userId).save({
      staples: [...new Set([...remote.staples, ...mine.staples])],
      aisle_map: { ...mine.aisle_map, ...remote.aisle_map },
      aisle_order: remote.aisle_order.length ? remote.aisle_order : mine.aisle_order,
    })
  }
  localStorage.removeItem(KEY)
  return !empty
}

export function makePrefsStore(userId) {
  return pickStore(userId, supabaseStore, localStore)
}
