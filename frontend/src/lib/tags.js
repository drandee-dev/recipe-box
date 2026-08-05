// Tag vocabulary and the search/filter logic the Recipes tab runs on.
//
// The vocabulary mirrors ALLOWED_TAGS in backend/app/ai.py, which enforces it as
// a JSON-schema enum so the AI cannot invent tags. This copy exists for the
// suggestion list in the tag editor — the two must be kept in step by hand, and
// a tag here that the backend doesn't know simply never arrives from an import.
//
// Hand-typed tags are NOT restricted to this list. The vocabulary is there to
// stop the AI from producing forty one-off tags across forty recipes; a person
// typing "mums-recipe" knows what they mean.

export const TAG_GROUPS = [
  { label: 'Meal', tags: ['breakfast', 'lunch', 'dinner', 'snack', 'dessert', 'side'] },
  {
    label: 'Dish',
    tags: ['soup', 'salad', 'pasta', 'pizza', 'sandwich', 'bread', 'drink', 'sauce'],
  },
  { label: 'Protein', tags: ['chicken', 'beef', 'pork', 'seafood', 'eggs', 'tofu', 'beans'] },
  {
    label: 'Cuisine',
    tags: ['italian', 'mexican', 'asian', 'indian', 'mediterranean', 'american'],
  },
  { label: 'Diet', tags: ['vegetarian', 'vegan', 'gluten-free', 'dairy-free', 'low-carb'] },
  {
    label: 'Method',
    tags: [
      'quick',
      'one-pot',
      'slow-cooker',
      'air-fryer',
      'grilled',
      'baked',
      'no-cook',
      'meal-prep',
    ],
  },
]

export const TAG_VOCABULARY = TAG_GROUPS.flatMap((g) => g.tags)

const MAX_TAG_LENGTH = 30

// Hand-typed tags get the same shape as vocabulary ones so the two sort, match
// and de-duplicate together: lowercase, spaces to hyphens, nothing exotic.
export function normalizeTag(raw) {
  return (raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_TAG_LENGTH)
}

// Every tag currently in use, with a count, most-used first. This is what the
// filter chips are built from — the vocabulary is not, because a chip for a tag
// no recipe has is a dead end.
export function tagCounts(recipes) {
  const counts = new Map()
  for (const recipe of recipes) {
    for (const tag of recipe.tags || []) {
      counts.set(tag, (counts.get(tag) || 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

// One searchable string per recipe. Ingredients are included because "what can
// I make with the ricotta" is the question actually being asked; the source
// hostname because "that allrecipes one" is how a link gets remembered.
//
// Instructions are deliberately left out. Terms are ANDed, so every extra field
// only ever widens the result set, and step text is full of words that appear in
// nearly every recipe ("heat", "stir", "minutes") — adding it would make each
// typed term less discriminating, not more.
function haystack(recipe) {
  const parts = [recipe.title, recipe.description || '', ...(recipe.tags || [])]
  for (const ing of recipe.ingredients || []) parts.push(ing.raw || '')
  if (recipe.source_url) {
    try {
      parts.push(new URL(recipe.source_url).hostname.replace('www.', ''))
    } catch {
      // A stored URL that no longer parses shouldn't break search.
    }
  }
  return parts.join('\n').toLowerCase()
}

// Terms are ANDed, so "chicken quick" narrows rather than widens. They don't
// have to appear in the same field or in order — this is a 200-recipe box, not
// a search engine, and substring matching is what people expect from it.
export function filterRecipes(recipes, { query = '', tags = [], favoritesOnly = false } = {}) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return recipes.filter((recipe) => {
    if (favoritesOnly && !recipe.favorite) return false
    if (tags.length > 0) {
      const own = recipe.tags || []
      if (!tags.every((tag) => own.includes(tag))) return false
    }
    if (terms.length === 0) return true
    const text = haystack(recipe)
    return terms.every((term) => text.includes(term))
  })
}
