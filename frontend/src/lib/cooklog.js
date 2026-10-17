// The cooked log's storage. Same shape as plan.js and shopping.js: localStorage
// when signed out, the cook_log table when signed in, and a one-time upload on
// sign-in that clears the local key.
//
// Ordering matters on that upload for the same reason it does for the plan:
// cook_log.recipe_id is a foreign key into recipes, so the recipes have to land
// first. migrateLocalRecipes keeps local ids, which is what keeps the references
// in these rows valid across the move.

import { client, localRows, pickStore, unwrap } from './backend.js'

const stored = localRows('recipebox:cooklog')
const COLS = 'id,recipe_id,cooked_at'

function toRow(entry) {
  return {
    id: entry.id || crypto.randomUUID(),
    recipe_id: entry.recipe_id,
    cooked_at: entry.cooked_at || new Date().toISOString(),
  }
}

const localStore = {
  async list() {
    return stored.read()
  },
  async add(entry) {
    const row = toRow(entry)
    stored.write([...stored.read(), row])
    return row
  },
  async remove(id) {
    stored.write(stored.read().filter((r) => r.id !== id))
  },
  async removeByRecipe(recipeId) {
    stored.write(stored.read().filter((r) => r.recipe_id !== recipeId))
  },
}

function supabaseStore(userId) {
  return {
    async list() {
      const supabase = await client()
      return unwrap(await supabase.from('cook_log').select(COLS).order('cooked_at', { ascending: false })) || []
    },
    async add(entry) {
      const supabase = await client()
      return unwrap(await supabase
        .from('cook_log')
        .insert({ ...toRow(entry), user_id: userId })
        .select(COLS)
        .single())
    },
    async remove(id) {
      const supabase = await client()
      unwrap(await supabase.from('cook_log').delete().eq('id', id))
    },
    // Deleting a recipe cascades server-side; this only exists so the local
    // backend behaves the same way.
    async removeByRecipe() {},
  }
}

export async function migrateLocalCookLog(userId) {
  const local = stored.read()
  if (local.length === 0) return 0
  const supabase = await client()
  const rows = local.map((r) => ({ ...toRow(r), user_id: userId }))
  unwrap(await supabase.from('cook_log').upsert(rows))
  stored.clear()
  return rows.length
}

export function makeCookStore(userId) {
  return pickStore(userId, supabaseStore, localStore)
}
