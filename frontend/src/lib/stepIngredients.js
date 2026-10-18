// Which ingredients a step uses, so cook mode can say "8 tbsp butter" on the
// step that melts it instead of sending you up a list to find it.
//
// Text matching only, and it never invents anything: what is shown is the
// recipe's own ingredient line (scaled by the caller), and a step that names
// nothing ("mix until combined", "spices") comes back empty rather than guessed.
//
// Three things make this harder than "is the word in the step":
//
// 1. A step says "sugar" for "brown sugar" and "vanilla" for "vanilla extract",
//    so the head noun (last word) matches on its own, and a word further back
//    ("vanilla", "lemon") matches only when nothing longer has claimed it.
// 2. A word can belong to a longer ingredient. "beat the cream cheese" must not
//    pull in the sour cream, and "lemon juice" must not pull in the lemon zest:
//    when a step spells out the end of an ingredient's name as a phrase, those
//    words are that ingredient's and nobody else's.
// 3. The same ingredient is listed more than once (butter for the crust, the
//    topping, the filling). Where both the ingredient lines and the steps carry
//    a section name, only the matching section's lines are used. Where they do
//    not, every candidate is returned, flagged `shared`, each with its own
//    quantity: showing three butters is honest, picking one is a guess.
//
// `ing.group` is the section an ingredient line sits under, and
// `recipe.instruction_groups[n]` the section of step n. Neither is stored yet, so
// today every recipe takes the "all candidates" path; the section rules are here,
// tested, for the day the import keeps them.

import { readIngredient, singular } from './ingredients.js'

// Words that describe an ingredient without telling it from another one.
const DESCRIPTORS = new Set([
  'fresh', 'freshly', 'large', 'medium', 'small', 'extra', 'finely', 'roughly', 'thinly',
  'thick', 'thin', 'boneless', 'skinless', 'ripe', 'firm', 'hot', 'cold', 'warm', 'optional',
  'plus', 'more', 'about', 'good', 'quality', 'room', 'temperature', 'full', 'fat', 'low',
  'unsalted', 'salted', 'ground', 'whole', 'block', 'pinch', 'dash', 'can', 'jar', 'package',
  'packet', 'bunch', 'all', 'purpose', 'quick', 'cooking', 'old', 'fashioned', 'each', 'of',
  'a', 'an', 'the', 'and', 'to', 'for', 'taste', 'pure', 'real', 'natural', 'organic',
  // What was done to it, not what it is: a step that says "cooked" or "diced" is
  // describing its own action, and these must never match another line.
  'cooked', 'uncooked', 'frozen', 'canned', 'dried', 'packed', 'softened', 'melted', 'chilled',
  'boiled', 'roasted', 'toasted', 'sliced', 'chopped', 'minced', 'diced', 'shredded', 'grated',
  'crushed', 'cubed', 'peeled', 'fire', 'leveled', 'spooned',
])

// A line may be found by a word other than its last ("vanilla" for vanilla
// extract, "chicken" for chicken breast) only when its last word is one of these:
// a form or a cut, which the step leaves unsaid. For any other head the extra
// word is too common in steps to trust ("baking" for baking soda, "onion" for
// onion powder).
const FORM_HEADS = new Set([
  'extract', 'zest', 'essence', 'breast', 'thigh', 'leg', 'wing', 'fillet', 'tender',
  'drumstick', 'cutlet', 'loin', 'chop', 'steak', 'rib', 'shoulder', 'belly',
])

// Words that are fine as the end of an ingredient but never mean one by
// themselves in a step ("whisk the spices" names no line).
const GENERIC = new Set(['spice', 'seasoning', 'herb', 'ingredient', 'mixture', 'liquid', 'topping', 'filling'])

// Words a step uses for a set of lines at once ("mix the sauce" means the soy sauce
// and the oyster sauce together), so a tie among them is not a tie to break.
const COLLECTIVE = new Set(['sauce', 'dressing', 'marinade', 'glaze', 'frosting', 'rub', 'syrup'])

// Colours and states that appear in steps as something other than the ingredient:
// "until golden brown" is not brown sugar.
const WEAK_BLOCK = new Set([
  'brown', 'golden', 'white', 'red', 'green', 'black', 'dark', 'light', 'yellow', 'sweet',
  'sour', 'hot', 'cold', 'soft', 'hard', 'raw', 'dry', 'wet',
])

// Section names are matched on what is left after these.
const GROUP_STOP = new Set(['for', 'the', 'a', 'and', 'make', 'prepare', 'ingredient', 'ingredients', 'to'])

function words(text) {
  return (String(text ?? '').toLowerCase().match(/[a-zà-ÿ]+/g) || []).map(singular)
}

// One entry per way the line can be named ("sour cream or Greek yogurt" is two).
function alternatives(ing) {
  let name = readIngredient(ing)?.name ?? ''
  // The parser keeps what is before the first comma as the name, which for
  // "boneless, skinless chicken breast" is just "boneless". When that leaves
  // nothing to match on, read the line again with the commas taken out.
  if (words(name).every((w) => DESCRIPTORS.has(w))) {
    name = readIngredient({ raw: String(ing.raw ?? '').replace(/,/g, ' ') })?.name ?? name
  }
  const out = []
  for (const alt of name.split(/\s+(?:or|\/)\s+/i)) {
    const tokens = words(alt).filter((w) => !DESCRIPTORS.has(w))
    if (tokens.length === 0) continue
    out.push({ tokens, head: tokens[tokens.length - 1], mods: tokens.slice(0, -1) })
  }
  return out
}

// Many sources open a step with its own title ("Fried Rice: Turn the heat up").
// That title names the stage, not an ingredient going in.
function withoutLabel(step) {
  return String(step ?? '').replace(/^[^.:!?]{1,30}:\s+/, '')
}

function groupWords(group) {
  return new Set(words(group).filter((w) => !GROUP_STOP.has(w)))
}

// "For the Topping" and "For the Crumble Topping" are the same section: one name's
// words are all in the other's.
function sameGroup(a, b) {
  const x = groupWords(a)
  const y = groupWords(b)
  if (x.size === 0 || y.size === 0) return false
  const [small, big] = x.size <= y.size ? [x, y] : [y, x]
  return [...small].every((w) => big.has(w))
}

// Where each word of the step sits, so a phrase can claim a run of them.
function claimPhrases(stepWords, alts) {
  const claimed = new Map() // position -> Set of ingredient indexes that own it
  alts.forEach((list, i) => {
    for (const { tokens } of list) {
      for (let len = tokens.length; len >= 2; len--) {
        const phrase = tokens.slice(-len)
        for (let p = 0; p + len <= stepWords.length; p++) {
          if (phrase.every((w, k) => stepWords[p + k] === w)) {
            for (let k = 0; k < len; k++) {
              if (!claimed.has(p + k)) claimed.set(p + k, new Set())
              claimed.get(p + k).add(i)
            }
          }
        }
      }
    }
  })
  return claimed
}

const usable = (claimed, p, i) => !claimed.has(p) || claimed.get(p).has(i)

// `open` is one list of tied candidates per word of the step; `fixed` the matches
// with no rival. Tries every pick (capped) and returns, per list, the candidates
// that appear in a tightest combination.
const MAX_COMBINATIONS = 2000

function narrowBySpan(fixed, open) {
  if (open.length === 0 || open.reduce((n, l) => n * l.length, 1) > MAX_COMBINATIONS) return open
  const base = fixed.map((f) => f.i)
  let best = Infinity
  let keep = open.map(() => new Set())
  const pick = []
  const walk = (k) => {
    if (k === open.length) {
      const at = [...base, ...pick.map((f) => f.i)]
      const span = Math.max(...at) - Math.min(...at)
      if (span < best) {
        best = span
        keep = open.map(() => new Set())
      }
      if (span === best) pick.forEach((f, j) => keep[j].add(f))
      return
    }
    for (const f of open[k]) {
      pick.push(f)
      walk(k + 1)
      pick.pop()
    }
  }
  walk(0)
  return open.map((list, j) => list.filter((f) => keep[j].has(f)))
}

function matchStep(step, stepGroup, ingredients, alts, hasGroups) {
  const stepWords = words(withoutLabel(step))
  if (stepWords.length === 0) return []
  const claimed = claimPhrases(stepWords, alts)

  // { i, pos, key, strong }
  let found = []
  alts.forEach((list, i) => {
    let best = null
    for (const { head, mods } of list) {
      let pos = -1
      let strong = false
      if (!GENERIC.has(head)) {
        pos = stepWords.findIndex((w, p) => w === head && usable(claimed, p, i))
        strong = pos >= 0
      }
      if (!strong && FORM_HEADS.has(head)) {
        for (const m of mods) {
          if (WEAK_BLOCK.has(m) || GENERIC.has(m) || m.length < 4) continue
          const p = stepWords.findIndex((w, q) => w === m && usable(claimed, q, i))
          if (p >= 0) {
            pos = p
            break
          }
        }
      }
      if (pos >= 0 && (!best || (strong && !best.strong))) best = { i, pos, head, bare: mods.length === 0, strong }
    }
    if (best) found.push(best)
  })

  // Section rule: only when this step's section names one of the ingredient
  // sections. A step called "Assemble & Bake" names none and filters nothing. A
  // line with no section is never filtered out.
  if (hasGroups && stepGroup) {
    const anyMatch = ingredients.some((ing) => ing.group && sameGroup(stepGroup, ing.group))
    if (anyMatch) {
      found = found.filter((f) => !ingredients[f.i].group || sameGroup(stepGroup, ingredients[f.i].group))
    }
  }

  // Lines that landed on the same word of the step are rivals for it ("butter"
  // with three butter lines; "oil" with an oil line and a sesame oil line). Where
  // one of them is the plain ingredient and the others carry a qualifier the step
  // did not use, the plain one wins. What is still tied stays, flagged `shared`.
  // ("brown sugar" never gets here against the granulated: the phrase claim above
  // already gave those words to the brown sugar.)
  const rivals = new Map()
  for (const f of found) rivals.set(f.pos, [...(rivals.get(f.pos) || []), f])
  const lists = [...rivals.values()].map((list) => {
    const bare = list.filter((f) => f.bare)
    return bare.length > 0 && bare.length < list.length ? bare : list
  })

  // Still tied with no section to settle it: a list is written section by
  // section, so the lines one step uses sit close together. Keep the combination
  // of candidates that spans the fewest places in the list. Where that is itself
  // a tie, every tied candidate stays.
  // A collective word ("Mix the sauce") means all of its lines, not one of them,
  // so those are neither narrowed nor used as anchors.
  const collective = lists.filter((l) => COLLECTIVE.has(l[0].head))
  const rest = lists.filter((l) => !COLLECTIVE.has(l[0].head))
  const single = rest.filter((l) => l.length === 1)
  const settled = narrowBySpan(single.flat(), rest.filter((l) => l.length > 1))

  const kept = []
  for (const list of [...single, ...collective, ...settled]) {
    for (const f of list) kept.push({ ...f, shared: list.length > 1 })
  }

  return kept
    .sort((a, b) => a.pos - b.pos || a.i - b.i)
    .map((f) => ({ index: f.i, shared: f.shared, group: ingredients[f.i].group || null }))
}

// One list per step: [{ index, shared, group }], `index` into recipe.ingredients,
// in the order the step mentions them.
export function stepIngredientMap(recipe) {
  const ingredients = recipe?.ingredients || []
  const steps = recipe?.instructions || []
  if (ingredients.length === 0 || steps.length === 0) return steps.map(() => [])
  const alts = ingredients.map(alternatives)
  const hasGroups = ingredients.some((ing) => ing.group)
  return steps.map((step, n) =>
    matchStep(step, recipe.instruction_groups?.[n] || null, ingredients, alts, hasGroups),
  )
}
