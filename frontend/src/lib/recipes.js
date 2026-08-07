// Two small presentational readers shared by the recipe card and the recipe
// detail sheet. They live here rather than in either component because both
// surfaces show the same facts about the same recipe, and pass 2 split those
// surfaces into separate files — a copy in each is how the card and the sheet
// end up disagreeing about what a link card says.

export function hostOf(url) {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace('www.', '')
  } catch {
    // A stored URL that no longer parses shouldn't break the card.
    return ''
  }
}

// Time first, then servings. That's the order every comparable app uses, and it
// matches what you're deciding at six o'clock. Ingredient count moved out: it
// answers "how much shopping", which belongs on the planner.
export function metaParts(recipe) {
  const parts = []
  if (recipe.total_min) parts.push(`${recipe.total_min} min`)
  if (recipe.servings) {
    const raw = String(recipe.servings).trim()
    parts.push(/serv|portion|makes/i.test(raw) ? raw : `Serves ${raw}`)
  }
  // A link card has neither, and an empty meta line reads as a rendering bug.
  if (parts.length === 0) {
    parts.push(recipe.ingredients?.length > 0 ? `${recipe.ingredients.length} ingredients` : 'Saved link')
  }
  return parts
}
