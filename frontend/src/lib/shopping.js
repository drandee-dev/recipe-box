// Shopping list overlay storage. Same shape as store.js and plan.js.
//
// The list itself is never stored: it is recomputed from the week's plan every
// time, so editing the plan updates the list with no regenerate step. What is
// stored is only what cannot be derived — which lines you have ticked off, and
// items you added by hand.
//
// `kind` separates those two. A check row's name is the merge key from
// buildShoppingList, not a display string, so it keeps matching as long as the
// line survives. Manual rows carry their own name and quantity.

import { client, localRows, pickStore, unwrap } from './backend.js'

const stored = localRows('recipebox:shopping')
const COLS = 'id,recipe_id,week_start,name,quantity,checked,kind,created_at'

function toRow(item) {
  return {
    id: item.id || crypto.randomUUID(),
    // Set on lines that came from "To list" on a recipe, so the list can say
    // where they came from. The column has always existed; nothing wrote it.
    recipe_id: item.recipe_id || null,
    week_start: item.week_start,
    name: item.name,
    quantity: item.quantity || null,
    checked: Boolean(item.checked),
    kind: item.kind === 'check' ? 'check' : 'manual',
  }
}

const localStore = {
  async listWeek(weekStartISO) {
    return stored.read().filter((r) => r.week_start === weekStartISO)
  },
  async add(item) {
    const row = { ...toRow(item), created_at: item.created_at || new Date().toISOString() }
    stored.write([...stored.read(), row])
    return row
  },
  async update(id, patch) {
    const rows = stored.read()
    const index = rows.findIndex((r) => r.id === id)
    if (index < 0) return null
    rows[index] = { ...rows[index], ...patch }
    stored.write(rows)
    return rows[index]
  },
  async remove(id) {
    stored.write(stored.read().filter((r) => r.id !== id))
  },
  async prune(beforeISO) {
    stored.write(stored.read().filter((r) => !(r.week_start && r.week_start < beforeISO)))
  },
}

function supabaseStore(userId) {
  return {
    async listWeek(weekStartISO) {
      const supabase = await client()
      return unwrap(await supabase
        .from('shopping_items')
        .select(COLS)
        .eq('week_start', weekStartISO)) || []
    },
    async add(item) {
      const supabase = await client()
      return unwrap(await supabase
        .from('shopping_items')
        .insert({ ...toRow(item), user_id: userId })
        .select(COLS)
        .single())
    },
    async update(id, patch) {
      const supabase = await client()
      return unwrap(await supabase
        .from('shopping_items')
        .update(patch)
        .eq('id', id)
        .select(COLS)
        .single())
    },
    async remove(id) {
      const supabase = await client()
      unwrap(await supabase.from('shopping_items').delete().eq('id', id))
    },
    // Rows for weeks long gone (AUDIT 10). Ticks and hand-added items are only
    // read for the week on screen, so old ones are dead weight on the free tier.
    // A null week_start never compares less-than, so it is never matched.
    async prune(beforeISO) {
      const supabase = await client()
      unwrap(await supabase.from('shopping_items').delete().lt('week_start', beforeISO))
    },
  }
}

// How many whole weeks back a week's ticks and hand-added items are kept.
export const KEEP_WEEKS = 8

export async function migrateLocalShopping(userId) {
  const local = stored.read()
  if (local.length === 0) return 0
  const supabase = await client()
  const rows = local.map((r) => ({
    ...toRow(r),
    user_id: userId,
    created_at: r.created_at || new Date().toISOString(),
  }))
  unwrap(await supabase.from('shopping_items').upsert(rows))
  stored.clear()
  return rows.length
}

export function makeShoppingStore(userId) {
  return pickStore(userId, supabaseStore, localStore)
}
