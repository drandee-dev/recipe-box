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
const COLS = 'id,recipe_id,plan_date,slot,servings,leftover,created_at'

// The table's check constraint rejects anything else.
function safeSlot(slot) {
  return SLOTS.includes(slot) ? slot : 'dinner'
}

// Null means "as the recipe says". Anything that is not a whole number the
// table's check (1 to 500) would accept is stored as null rather than refused,
// since a bad value here should cost a scale, not a meal.
export function safeServings(servings) {
  const n = Math.round(Number(servings))
  return Number.isFinite(n) && n >= 1 && n <= 500 ? n : null
}

function toRow(entry) {
  return {
    id: entry.id || crypto.randomUUID(),
    recipe_id: entry.recipe_id,
    plan_date: entry.plan_date,
    slot: safeSlot(entry.slot),
    servings: safeServings(entry.servings),
    // Leftovers are eaten, not bought for. False is the default and the only
    // thing a row written before this existed can mean.
    leftover: Boolean(entry.leftover),
  }
}

// The only fields a planned meal lets you change after the fact. A patch is
// built from this, never passed through, so a stray key can't reach the table.
function toPatch(patch) {
  const out = {}
  if ('plan_date' in patch) out.plan_date = patch.plan_date
  if ('slot' in patch) out.slot = safeSlot(patch.slot)
  if ('servings' in patch) out.servings = safeServings(patch.servings)
  if ('leftover' in patch) out.leftover = Boolean(patch.leftover)
  return out
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
  async update(id, patch) {
    const rows = stored.read()
    const index = rows.findIndex((e) => e.id === id)
    if (index < 0) return null
    rows[index] = { ...rows[index], ...toPatch(patch) }
    stored.write(rows)
    return rows[index]
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
    async update(id, patch) {
      const supabase = await client()
      return unwrap(await supabase
        .from('meal_plan')
        .update(toPatch(patch))
        .eq('id', id)
        .select(COLS)
        .single())
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
