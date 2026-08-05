// Recipe storage abstraction with two interchangeable backends:
//   - localStore: this browser only (localStorage). Used when Supabase isn't
//     configured or the user isn't signed in.
//   - supabaseStore: cloud-synced per account (RLS scopes rows to the user).
//
// On sign-in, migrateLocalRecipes uploads local captures and clears the local
// key, so the cloud is the single source of truth while signed in. Signed-out
// usage stays local-only.

import { supabase } from './supabase.js'

const LOCAL_KEY = 'recipebox:recipes'

const COLS =
  'id,title,source_url,source_type,image_url,description,ingredients,instructions,' +
  'prep_min,cook_min,total_min,servings,tags,favorite,created_at,updated_at'

const SOURCE_TYPES = new Set(['web', 'tiktok', 'instagram', 'manual'])

// Extraction output may omit fields, and the DB check constraint rejects
// unknown source_type values — shape every write to match supabase/schema.sql.
function toRow(recipe) {
  return {
    id: recipe.id || crypto.randomUUID(),
    title: recipe.title || 'Untitled recipe',
    source_url: recipe.source_url || null,
    source_type: SOURCE_TYPES.has(recipe.source_type) ? recipe.source_type : 'manual',
    image_url: recipe.image_url || null,
    description: recipe.description || null,
    ingredients: recipe.ingredients || [],
    instructions: recipe.instructions || [],
    prep_min: recipe.prep_min ?? null,
    cook_min: recipe.cook_min ?? null,
    total_min: recipe.total_min ?? null,
    servings: recipe.servings || null,
    tags: recipe.tags || [],
    favorite: Boolean(recipe.favorite),
  }
}

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY)) || []
  } catch {
    return []
  }
}

const localStore = {
  async list() {
    return readLocal().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
  },
  async save(recipe) {
    const recipes = readLocal()
    const idx = recipes.findIndex((r) => r.id === recipe.id)
    if (idx >= 0) recipes[idx] = recipe
    else recipes.unshift(recipe)
    localStorage.setItem(LOCAL_KEY, JSON.stringify(recipes))
    return recipe
  },
  async remove(id) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(readLocal().filter((r) => r.id !== id)))
  },
}

function supabaseStore(userId) {
  return {
    async list() {
      const { data, error } = await supabase
        .from('recipes')
        .select(COLS)
        .order('created_at', { ascending: false })
      if (error) throw new Error(error.message)
      return data || []
    },
    async save(recipe) {
      const row = { ...toRow(recipe), user_id: userId, updated_at: new Date().toISOString() }
      const { data, error } = await supabase
        .from('recipes')
        .upsert(row)
        .select(COLS)
        .single()
      if (error) throw new Error(error.message)
      return data
    },
    async remove(id) {
      const { error } = await supabase.from('recipes').delete().eq('id', id)
      if (error) throw new Error(error.message)
    },
  }
}

// One-time upload of local captures after sign-in. Clearing the local key on
// success is what makes this run only once per browser.
export async function migrateLocalRecipes(userId) {
  const local = readLocal()
  if (local.length === 0) return 0
  const rows = local.map((r) => ({
    ...toRow(r),
    user_id: userId,
    created_at: r.created_at || new Date().toISOString(),
  }))
  const { error } = await supabase.from('recipes').upsert(rows)
  if (error) throw new Error(error.message)
  localStorage.removeItem(LOCAL_KEY)
  return rows.length
}

// Pick the active backend. Cloud when signed in; local otherwise.
export function makeStore(userId) {
  return userId && supabase ? supabaseStore(userId) : localStore
}
