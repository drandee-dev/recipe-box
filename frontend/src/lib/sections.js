// Section headings ("For the crust") over a list of ingredients or steps.
//
// A recipe's lines carry the name of the part they sit under, and the heading is
// drawn once, above the first line of each run. Nothing here reorders: a line
// moved to sit under another heading in the editor keeps its own name, so the
// heading simply repeats where the run changes.

// The heading to draw above item `n`, or null when none is due: the item has no
// section, or it is in the same section as the item before it.
export function headingAt(groups, n) {
  const name = groups?.[n] || null
  if (!name) return null
  return name === (groups[n - 1] || null) ? null : name
}

// A list's section names, one per item, for `headingAt`. Null when nothing in it
// is named, which is the cheap test for "this recipe has no sections".
export function ingredientGroups(ingredients) {
  const names = (ingredients || []).map((ing) => (ing && typeof ing === 'object' && ing.group) || null)
  return names.some(Boolean) ? names : null
}
