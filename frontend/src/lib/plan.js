// Meal plan storage. Deliberately the same shape as store.js: localStorage
// when signed out, the meal_plan table when signed in, and a one-time upload
// on sign-in that clears the local key.
//
// Ordering matters on that upload. meal_plan.recipe_id is a foreign key into
// recipes, so the recipes have to land first or every row is rejected.
// migrateLocalRecipes preserves local ids, which is what keeps the references
// in these rows valid across the move.

import { supabase } from './supabase.js'
import { SLOTS } from './dates.js'

const LOCAL_KEY = 'recipebox:plan'
const COLS = 'id,recipe_id,plan_date,slot,created_at'

// The table's check constraint rejects anything else.
function safeSlot(slot) {
  return SLOTS.includes(slot) ? slot : 'dinner'
}

function toRow(entry) {
  return {
    id: entry.id || crypto.randomUUID(),
    recipe_id: entry.recipe_id,
    plan_date: entry.plan_date,
    slot: safeSlot(entry.slot),
  }
}

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY)) || []
  } catch {
    return []
  }
}

function writeLocal(entries) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(entries))
}

const localStore = {
  async listWeek(startISO, endISO) {
    // Dates are zero-padded ISO, so string comparison is date comparison.
    return readLocal().filter((e) => e.plan_date >= startISO && e.plan_date <= endISO)
  },
  async add(entry) {
    const row = { ...toRow(entry), created_at: entry.created_at || new Date().toISOString() }
    writeLocal([...readLocal(), row])
    return row
  },
  async remove(id) {
    writeLocal(readLocal().filter((e) => e.id !== id))
  },
  async removeByRecipe(recipeId) {
    writeLocal(readLocal().filter((e) => e.recipe_id !== recipeId))
  },
}

function supabaseStore(userId) {
  return {
    async listWeek(startISO, endISO) {
      const { data, error } = await supabase
        .from('meal_plan')
        .select(COLS)
        .gte('plan_date', startISO)
        .lte('plan_date', endISO)
        .order('plan_date', { ascending: true })
      if (error) throw new Error(error.message)
      return data || []
    },
    async add(entry) {
      const { data, error } = await supabase
        .from('meal_plan')
        .insert({ ...toRow(entry), user_id: userId })
        .select(COLS)
        .single()
      if (error) throw new Error(error.message)
      return data
    },
    async remove(id) {
      const { error } = await supabase.from('meal_plan').delete().eq('id', id)
      if (error) throw new Error(error.message)
    },
    // Deleting a recipe cascades server-side; this only exists so the local
    // backend behaves the same way.
    async removeByRecipe() {},
  }
}

export async function migrateLocalPlan(userId) {
  const local = readLocal()
  if (local.length === 0) return 0
  const rows = local.map((e) => ({
    ...toRow(e),
    user_id: userId,
    created_at: e.created_at || new Date().toISOString(),
  }))
  const { error } = await supabase.from('meal_plan').upsert(rows)
  if (error) throw new Error(error.message)
  localStorage.removeItem(LOCAL_KEY)
  return rows.length
}

export function makePlanStore(userId) {
  return userId && supabase ? supabaseStore(userId) : localStore
}
