// Recipe storage abstraction with two interchangeable backends:
//   - localStore: this browser only (localStorage). Used when Supabase isn't
//     configured or the user isn't signed in.
//   - supabaseStore: cloud-synced per account (RLS scopes rows to the user).
//
// On sign-in, migrateLocalRecipes uploads local captures and clears the local
// key, so the cloud is the single source of truth while signed in. Signed-out
// usage stays local-only.

import { client, localRows, pickStore, unwrap } from './backend.js'

const stored = localRows('recipebox:recipes')
const COLS =
  'id,title,source_url,source_type,image_url,image_thumb_url,image_blur,description,' +
  'ingredients,instructions,prep_min,cook_min,total_min,servings,tags,favorite,' +
  'created_at,updated_at'

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
    // Every write goes through here, so a column left out of this shape is a
    // column that a favourite toggle silently wipes. Phase 7's three travel
    // together: the mirrored widths and the inline blur are one photo.
    image_thumb_url: recipe.image_thumb_url || null,
    image_blur: recipe.image_blur || null,
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

const localStore = {
  async list() {
    return stored.read().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
  },
  async save(recipe) {
    const recipes = stored.read()
    const idx = recipes.findIndex((r) => r.id === recipe.id)
    if (idx >= 0) recipes[idx] = recipe
    else recipes.unshift(recipe)
    stored.write(recipes)
    return recipe
  },
  async remove(id) {
    stored.write(stored.read().filter((r) => r.id !== id))
  },
  // Unreachable in practice — mirroring needs a bucket, so it only runs signed
  // in — but the two backends stay interchangeable, and a store method missing
  // from one of them is how that stops being true.
  async saveImage(id, columns) {
    const recipes = stored.read()
    const idx = recipes.findIndex((r) => r.id === id)
    if (idx < 0) return null
    recipes[idx] = { ...recipes[idx], ...columns }
    stored.write(recipes)
    return recipes[idx]
  },
}

function supabaseStore(userId) {
  return {
    async list() {
      const supabase = await client()
      return unwrap(await supabase
        .from('recipes')
        .select(COLS)
        .order('created_at', { ascending: false })) || []
    },
    async save(recipe) {
      const supabase = await client()
      const row = { ...toRow(recipe), user_id: userId, updated_at: new Date().toISOString() }
      return unwrap(await supabase
        .from('recipes')
        .upsert(row)
        .select(COLS)
        .single())
    },
    // An update, not the save() upsert above, and that is the point: mirroring
    // runs in the background seconds after a recipe appears, so the row it was
    // handed is already out of date if the user starred it in the meantime.
    // Writing three named columns can't undo an edit it never saw.
    async saveImage(id, columns) {
      const supabase = await client()
      return unwrap(await supabase
        .from('recipes')
        .update({ ...columns, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select(COLS)
        .maybeSingle())
    },
    async remove(id) {
      const supabase = await client()
      unwrap(await supabase.from('recipes').delete().eq('id', id))
      // Storage has no foreign keys, so deleting the row leaves the photos
      // behind. Nothing would ever read them again and nothing would ever
      // remove them either, which on a free tier is a quota that fills up for
      // no reason. Best effort: the row is already gone, and failing the whole
      // delete over a leftover object would be the wrong trade.
      try {
        await supabase.storage
          .from('recipe-images')
          .remove([`${userId}/${id}-lg.jpg`, `${userId}/${id}-sm.jpg`])
      } catch {
        // Offline, or the objects were never there because the mirror failed.
      }
    },
  }
}

// One-time upload of local captures after sign-in. Clearing the local key on
// success is what makes this run only once per browser.
export async function migrateLocalRecipes(userId) {
  const local = stored.read()
  if (local.length === 0) return 0
  const supabase = await client()
  const rows = local.map((r) => ({
    ...toRow(r),
    user_id: userId,
    created_at: r.created_at || new Date().toISOString(),
  }))
  unwrap(await supabase.from('recipes').upsert(rows))
  stored.clear()
  return rows.length
}

// Pick the active backend. Cloud when signed in; local otherwise.
export function makeStore(userId) {
  return pickStore(userId, supabaseStore, localStore)
}
