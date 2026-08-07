// Two small presentational readers shared by the recipe card and the recipe
// detail sheet. They live here rather than in either component because both
// surfaces show the same facts about the same recipe, and pass 2 split those
// surfaces into separate files — a copy in each is how the card and the sheet
// end up disagreeing about what a link card says.

// Ruled section labels over the grid (pass 3, Direction B). Grouping is by when
// a recipe was saved because that is the only ordering the list already has —
// `store.list` sorts on created_at descending, so the bands fall out in order
// without a second sort and a recipe never appears under a heading that
// contradicts its position.
//
// The caller drops these while a search or a tag filter is on. Three headings
// over a filtered result of four recipes is worse than none, and the question
// "when did I save this" is not the one being asked mid-search.
const DAY_MS = 24 * 60 * 60 * 1000
const RECENCY_BANDS = [
  { label: 'Recently saved', within: 7 },
  { label: 'Earlier this month', within: 30 },
  { label: 'Earlier', within: Number.POSITIVE_INFINITY },
]

export function groupByRecency(recipes, now = Date.now()) {
  const groups = RECENCY_BANDS.map(({ label }) => ({ label, recipes: [] }))
  for (const recipe of recipes) {
    const saved = Date.parse(recipe?.created_at)
    // An unreadable created_at means old, not new. MAX_VALUE rather than
    // Infinity on purpose: the last band's bound *is* Infinity, and
    // `Infinity < Infinity` is false, so an Infinity age would match no band
    // at all and throw on the push.
    const days = Number.isFinite(saved) ? (now - saved) / DAY_MS : Number.MAX_VALUE
    groups[RECENCY_BANDS.findIndex((band) => days < band.within)].recipes.push(recipe)
  }
  return groups.filter((group) => group.recipes.length > 0)
}

export function hostOf(url) {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace('www.', '')
  } catch {
    // A stored URL that no longer parses shouldn't break the card.
    return ''
  }
}

// Minutes stop being a unit you can think in somewhere around an hour and a
// half. The overnight focaccia read "720 min" and the lamb "300 min" — the two
// largest numbers on the screen, and the only thing either told you was that
// you had arithmetic to do (finding 9). Below the threshold minutes stay
// minutes, because "45 min" is a real amount of evening and "0 hr 45" is not.
const HOURS_FROM = 90
const DAYS_FROM = 24 * 60

export function formatMinutes(min) {
  const n = Math.round(Number(min))
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < HOURS_FROM) return `${n} min`
  // A sourdough starter is 10,080 minutes. "168 hr" is the same problem as
  // "720 min" one unit further along, so the ladder has a third rung.
  if (n >= DAYS_FROM) {
    const days = Math.round(n / DAYS_FROM)
    return `${days} day${days === 1 ? '' : 's'}`
  }
  const hours = Math.floor(n / 60)
  const rest = n % 60
  // "1 hr 30", not "1 hr 30 min". The unit is stated once already, and the
  // second one is what pushes the line past the width of a two-column cell.
  return rest ? `${hours} hr ${rest}` : `${hours} hr`
}

// Dead time, not long time. A five-hour braise is five hours you spend at home
// with the oven on; a twelve-hour focaccia is eleven and a half hours of
// nothing happening, and *that* is the fact that decides whether tonight is
// possible. So this keys on the total minus the active work rather than on the
// total alone — the exception being a recipe with no breakdown to subtract,
// where the total is all there is and eight hours of anything has already
// ruled tonight out.
const IDLE_FROM = 240
const TOTAL_FROM = 480

export function isOvernight(recipe) {
  const total = Math.round(Number(recipe?.total_min))
  if (!Number.isFinite(total) || total <= 0) return false
  // Past a day it is not overnight, it is a project, and the word would be a
  // plain untruth on a seven-day sourdough starter. There the duration is the
  // useful fact and formatMinutes already says it in days, so let it.
  if (total >= DAYS_FROM) return false
  const active = (Number(recipe.prep_min) || 0) + (Number(recipe.cook_min) || 0)
  if (active <= 0) return total >= TOTAL_FROM
  return total - active >= IDLE_FROM
}

// Time first, then servings. That's the order every comparable app uses, and it
// matches what you're deciding at six o'clock. Ingredient count moved out: it
// answers "how much shopping", which belongs on the planner.
//
// `exact` is the difference between the two surfaces that call this. A grid cell
// has one line for the whole meta run, so there the word replaces the number —
// "Overnight" is the answer to the question the number was being read for. The
// detail sheet has room for both, and someone who has already opened a recipe
// wants to know how long twelve hours actually is.
export function metaParts(recipe, { exact = false } = {}) {
  const parts = []
  const time = formatMinutes(recipe.total_min)
  const overnight = isOvernight(recipe)
  if (time) {
    if (overnight && !exact) parts.push('Overnight')
    else {
      parts.push(time)
      if (overnight) parts.push('overnight')
    }
  }
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
