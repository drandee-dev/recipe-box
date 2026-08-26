// Meal plan storage. Deliberately the same shape as store.js: localStorage
// when signed out, the meal_plan table when signed in, and a one-time upload
// on sign-in that clears the local key.
//
// Ordering matters on that upload. meal_plan.recipe_id is a foreign key into
// recipes, so the recipes have to land first or every row is rejected.
// migrateLocalRecipes preserves local ids, which is what keeps the references
// in these rows valid across the move.

import { client, localRows, pickStore, unwrap } from './backend.js'
import { SLOTS } from './dates.js'

const stored = localRows('recipebox:plan')
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

const localStore = {
  async listWeek(startISO, endISO) {
    // Dates are zero-padded ISO, so string comparison is date comparison.
    return stored.read().filter((e) => e.plan_date >= startISO && e.plan_date <= endISO)
  },
  async add(entry) {
    const row = { ...toRow(entry), created_at: entry.created_at || new Date().toISOString() }
    stored.write([...stored.read(), row])
    return row
  },
  async remove(id) {
    stored.write(stored.read().filter((e) => e.id !== id))
  },
  async removeByRecipe(recipeId) {
    stored.write(stored.read().filter((e) => e.recipe_id !== recipeId))
  },
}

function supabaseStore(userId) {
  return {
    async listWeek(startISO, endISO) {
      const supabase = await client()
      return unwrap(await supabase
        .from('meal_plan')
        .select(COLS)
        .gte('plan_date', startISO)
        .lte('plan_date', endISO)
        .order('plan_date', { ascending: true })) || []
    },
    async add(entry) {
      const supabase = await client()
      return unwrap(await supabase
        .from('meal_plan')
        .insert({ ...toRow(entry), user_id: userId })
        .select(COLS)
        .single())
    },
    async remove(id) {
      const supabase = await client()
      unwrap(await supabase.from('meal_plan').delete().eq('id', id))
    },
    // Deleting a recipe cascades server-side; this only exists so the local
    // backend behaves the same way.
    async removeByRecipe() {},
  }
}

export async function migrateLocalPlan(userId) {
  const local = stored.read()
  if (local.length === 0) return 0
  const supabase = await client()
  const rows = local.map((e) => ({
    ...toRow(e),
    user_id: userId,
    created_at: e.created_at || new Date().toISOString(),
  }))
  unwrap(await supabase.from('meal_plan').upsert(rows))
  stored.clear()
  return rows.length
}

export function makePlanStore(userId) {
  return pickStore(userId, supabaseStore, localStore)
}
