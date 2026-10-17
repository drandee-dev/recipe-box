// Ingredient parsing, merging and aisle grouping for the shopping list.
//
// This has to work hard because extract.py leaves item/qty/unit null on every
// JSON-LD import, so for most saved recipes the only thing available is the
// raw line. Recipes that came through the AI structurer already have the
// fields filled and skip the parser entirely.
//
// The rule throughout: never lose information. Anything that cannot be parsed
// is carried to the list verbatim and simply doesn't merge with anything.

import { DIMENSION, MEASURE_ALIASES, bestUnit, systemOf, toBase } from './units.js'
import { baseServings } from './recipes.js'

const VULGAR = {
  '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
}

// Canonical unit to the spellings seen in real recipes. Merging happens on the
// canonical form, so "2 tablespoons" and "1 tbsp" add up. The measures (cups,
// spoons, grams...) live in units.js, which is also where they convert.
const UNIT_ALIASES = {
  ...MEASURE_ALIASES,
  clove: ['clove', 'cloves'],
  can: ['can', 'cans'],
  jar: ['jar', 'jars'],
  package: ['package', 'packages', 'pkg', 'pack', 'packs'],
  stick: ['stick', 'sticks'],
  slice: ['slice', 'slices'],
  bunch: ['bunch', 'bunches'],
  head: ['head', 'heads'],
  sprig: ['sprig', 'sprigs'],
  stalk: ['stalk', 'stalks'],
  pinch: ['pinch', 'pinches'],
  dash: ['dash', 'dashes'],
  handful: ['handful', 'handfuls'],
}

const UNIT_LOOKUP = new Map()
for (const [canonical, aliases] of Object.entries(UNIT_ALIASES)) {
  for (const alias of aliases) UNIT_LOOKUP.set(alias, canonical)
}

// Plural forms for display, so a merged line reads "3 cups" not "3 cup".
const UNIT_PLURALS = {
  cup: 'cups', clove: 'cloves', can: 'cans', jar: 'jars', package: 'packages',
  stick: 'sticks', slice: 'slices', bunch: 'bunches', head: 'heads',
  sprig: 'sprigs', stalk: 'stalks', pinch: 'pinches', dash: 'dashes',
  handful: 'handfuls', quart: 'quarts', pint: 'pints', gallon: 'gallons',
}

export const AISLE_ORDER = ['Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Bakery', 'Frozen', 'Pantry', 'Other']

// Matched by longest keyword first, which is what keeps "bell pepper" in
// Produce while bare "pepper" falls to Pantry as the spice, and stops
// "garlic powder" being filed next to fresh garlic.
const AISLE_KEYWORDS = {
  Produce: [
    'onion', 'red onion', 'yellow onion', 'green onion', 'scallion', 'shallot', 'leek',
    'garlic', 'ginger', 'tomato', 'cherry tomato', 'lettuce', 'romaine', 'spinach', 'arugula',
    'kale', 'cabbage', 'carrot', 'celery', 'bell pepper', 'red pepper', 'green pepper',
    'jalapeno', 'jalapeño', 'serrano', 'poblano', 'potato', 'sweet potato', 'mushroom',
    'cucumber', 'zucchini', 'squash', 'eggplant', 'broccoli', 'cauliflower', 'asparagus',
    'green bean', 'corn', 'avocado', 'lemon', 'lime', 'orange', 'apple', 'banana', 'pear',
    'berry', 'strawberry', 'blueberry', 'raspberry', 'grape', 'mango', 'pineapple', 'peach',
    'cilantro', 'parsley', 'basil', 'mint', 'dill', 'chive', 'thyme', 'rosemary', 'sage',
    'radish', 'beet', 'turnip', 'fennel', 'bok choy', 'sprout',
  ],
  'Meat & Seafood': [
    'chicken', 'chicken breast', 'chicken thigh', 'beef', 'ground beef', 'steak', 'brisket',
    'pork', 'pork belly', 'bacon', 'sausage', 'chorizo', 'ham', 'prosciutto', 'pancetta',
    'turkey', 'lamb', 'veal', 'duck', 'shrimp', 'prawn', 'salmon', 'tuna', 'cod', 'tilapia',
    'halibut', 'fish', 'crab', 'lobster', 'scallop', 'mussel', 'clam', 'squid', 'anchovy',
  ],
  'Dairy & Eggs': [
    'milk', 'whole milk', 'buttermilk', 'butter', 'unsalted butter', 'cream', 'heavy cream',
    'sour cream', 'creme fraiche', 'crème fraîche', 'half and half', 'yogurt', 'greek yogurt',
    'cheese', 'parmesan', 'mozzarella', 'cheddar', 'feta', 'ricotta', 'gruyere', 'provolone',
    'cream cheese', 'mascarpone', 'egg', 'egg white', 'egg yolk', 'ghee',
  ],
  Bakery: [
    'bread', 'sourdough', 'baguette', 'brioche', 'bun', 'roll', 'tortilla', 'pita', 'naan',
    'bagel', 'croissant', 'english muffin', 'pizza dough', 'puff pastry', 'phyllo',
  ],
  Frozen: ['frozen', 'ice cream', 'frozen peas', 'frozen corn', 'puff pastry sheet'],
  Pantry: [
    'flour', 'all-purpose flour', 'bread flour', 'sugar', 'brown sugar', 'powdered sugar',
    'salt', 'kosher salt', 'sea salt', 'pepper', 'black pepper', 'white pepper', 'peppercorn',
    'oil', 'olive oil', 'vegetable oil', 'sesame oil', 'canola oil', 'coconut oil',
    'vinegar', 'balsamic vinegar', 'rice vinegar', 'apple cider vinegar',
    'rice', 'pasta', 'spaghetti', 'penne', 'noodle', 'ramen', 'couscous', 'quinoa', 'lentil',
    'chickpea', 'black bean', 'kidney bean', 'oat', 'oats', 'cornmeal', 'breadcrumb', 'panko',
    'soy sauce', 'fish sauce', 'hoisin', 'oyster sauce', 'sriracha', 'worcestershire',
    'mustard', 'dijon mustard', 'mayonnaise', 'ketchup', 'hot sauce', 'salsa', 'tahini',
    'stock', 'chicken stock', 'beef stock', 'broth', 'chicken broth', 'vegetable broth',
    'tomato paste', 'tomato sauce', 'crushed tomato', 'canned tomato', 'coconut milk',
    'baking powder', 'baking soda', 'yeast', 'cornstarch', 'gelatin', 'vanilla',
    'vanilla extract', 'honey', 'maple syrup', 'molasses', 'jam', 'peanut butter',
    'chocolate', 'cocoa', 'chocolate chip', 'almond', 'walnut', 'pecan', 'cashew', 'pine nut',
    'sesame seed', 'sunflower seed', 'raisin', 'date', 'coconut',
    'cumin', 'paprika', 'smoked paprika', 'chili powder', 'cayenne', 'cinnamon', 'nutmeg',
    'clove', 'cardamom', 'coriander', 'turmeric', 'curry powder', 'garam masala', 'oregano',
    'bay leaf', 'red pepper flake', 'italian seasoning', 'onion powder', 'garlic powder',
    'wine', 'white wine', 'red wine', 'beer', 'water', 'coffee', 'tea',
  ],
}

// Flattened once, longest first, so the most specific keyword wins.
const AISLE_INDEX = Object.entries(AISLE_KEYWORDS)
  .flatMap(([aisle, words]) => words.map((word) => ({ aisle, word })))
  .sort((a, b) => b.word.length - a.word.length)

// Ingredients whose variants are the same shopping decision, so chicken breast
// and chicken thigh sit together instead of drifting apart alphabetically.
// Curated rather than derived: taking the head noun would file olive oil and
// sesame oil under one heading as "oil", which is a different purchase.
//
// Grouping only ever happens inside one aisle, which is what stops bell pepper
// (Produce) and black pepper (Pantry) from meeting. It also never sums across
// variants — 2 breasts plus 4 thighs is not 6 of anything.
const BASE_INGREDIENTS = [
  'chicken', 'beef', 'pork', 'lamb', 'turkey', 'duck', 'bacon', 'sausage',
  'salmon', 'tuna', 'cod', 'shrimp', 'fish',
  'egg', 'milk', 'cream', 'butter', 'cheese', 'yogurt',
  'flour', 'sugar', 'rice', 'pasta', 'noodle', 'bean', 'lentil', 'oat',
  'oil', 'vinegar', 'stock', 'broth', 'chocolate', 'sauce',
  'onion', 'potato', 'tomato', 'mushroom', 'pepper', 'lettuce', 'apple', 'berry',
].sort((a, b) => b.length - a.length)

// Names are normalized first so plurals collapse: "chicken breasts" -> base
// "chicken", "eggs" -> base "egg".
export function baseFor(name) {
  const hay = ` ${normalizeName(name)} `
  return BASE_INGREDIENTS.find((base) => hay.includes(` ${base} `)) || null
}

export function aisleFor(name) {
  const hay = ` ${name.toLowerCase()} `
  const hit = AISLE_INDEX.find(({ word }) => hay.includes(` ${word} `) || hay.includes(`${word} `) || hay.includes(` ${word}`))
  return hit ? hit.aisle : 'Other'
}

// Leading "2", "1.5", "1/2", "1 1/2", "½", "1½", "2-3", "2 to 3".
// A range takes its low end: buying for the smaller amount and topping up beats
// silently doubling a shopping list.
function takeQuantity(text) {
  let rest = text
  let total = null

  const mixed = rest.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)\s*/)
  if (mixed) {
    total = Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3])
    return [total, rest.slice(mixed[0].length)]
  }

  const wholeAndVulgar = rest.match(/^(\d+)\s*([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])\s*/)
  if (wholeAndVulgar) {
    total = Number(wholeAndVulgar[1]) + VULGAR[wholeAndVulgar[2]]
    return [total, rest.slice(wholeAndVulgar[0].length)]
  }

  const fraction = rest.match(/^(\d+)\s*\/\s*(\d+)\s*/)
  if (fraction) {
    total = Number(fraction[1]) / Number(fraction[2])
    return [total, rest.slice(fraction[0].length)]
  }

  const vulgarOnly = rest.match(/^([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])\s*/)
  if (vulgarOnly) {
    return [VULGAR[vulgarOnly[1]], rest.slice(vulgarOnly[0].length)]
  }

  const plain = rest.match(/^(\d+(?:\.\d+)?)\s*(?:-|–|to\s)?\s*(?:\d+(?:\.\d+)?)?\s*/)
  if (plain) {
    total = Number(plain[1])
    rest = rest.slice(plain[0].length)
    return [total, rest]
  }

  return [null, rest]
}

// "fl oz" is two words, and a lone "oz" is weight: reading "8 fl oz milk" as 8
// ounces of weight would put a mass on a volume and merge it with the wrong
// thing. Checked first so the "fl" is never taken as part of the name.
const FLUID_OUNCE = /^(?:fl\.?\s*oz\.?|fluid\s+ounces?)\s+/i

function takeUnit(text) {
  const fluid = text.match(FLUID_OUNCE)
  if (fluid) return ['floz', text.slice(fluid[0].length)]
  const match = text.match(/^([a-zA-Z]+)\.?\s+/)
  if (!match) return [null, text]
  const canonical = UNIT_LOOKUP.get(match[1].toLowerCase())
  if (!canonical) return [null, text]
  return [canonical, text.slice(match[0].length)]
}

// Merge keys only. Display always uses what the recipe actually said.
//
// The `o` in that character class is what handles tomatoes and potatoes, and it
// was missing: without it the rule falls through to "drop the trailing s", which
// turns "tomatoes" into "tomatoe" and leaves it as a different key from
// "tomato". A recipe calling for 3 tomatoes and one calling for 1 tomato then
// produced two lines, neither of them the amount to buy — the exact failure this
// function exists to prevent, on two of the most commonly bought things in the
// shop. It is deliberately not conditioned on anything cleverer: `o` also
// over-collapses words like "shoes", which are not ingredients, and this string
// is never shown to anyone.
function singular(word) {
  if (word.length <= 3) return word
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (/(ch|sh|s|x|z|o)es$/.test(word)) return word.slice(0, -2)
  if (word.endsWith('ss') || word.endsWith('us')) return word
  if (word.endsWith('s')) return word.slice(0, -1)
  return word
}

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/[.,;]+$/, '')
    .split(/\s+/)
    .map(singular)
    .join(' ')
    .trim()
}

// "2 cups all-purpose flour, sifted" -> { qty: 2, unit: 'cup', name: 'all-purpose flour' }
export function parseIngredient(raw) {
  const original = String(raw || '').trim()
  if (!original) return null

  let text = original
    .replace(/^[-*•\s]+/, '')
    // Parentheticals are usually can sizes or notes. Dropping them loses some
    // detail, but keeping them wrecks the merge key.
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // Everything after the first comma is prep, not identity: "onion, diced".
  const comma = text.indexOf(',')
  if (comma > 0) text = text.slice(0, comma)

  const [qty, afterQty] = takeQuantity(text)
  const [unit, afterUnit] = takeUnit(afterQty)

  let name = afterUnit.replace(/^of\s+/i, '').trim()
  // Trailing prep words that survive when there was no comma.
  name = name.replace(/\s+(chopped|minced|diced|sliced|grated|shredded|melted|softened|beaten|peeled|crushed|torn|halved|quartered|cubed|julienned|to taste|for garnish|optional|divided|plus more.*)$/i, '').trim()
  name = name.replace(/[.,;]+$/, '').trim()

  if (!name) return null

  return {
    qty: qty ?? null,
    unit,
    name,
    raw: original,
    // Anything without both a number and a recognised unit stays unmerged, so
    // "salt to taste" never gets added to "1 tsp salt".
    parsed: qty !== null,
  }
}

const FRACTION_LABELS = [
  [1 / 8, '1/8'], [1 / 4, '1/4'], [1 / 3, '1/3'], [3 / 8, '3/8'], [1 / 2, '1/2'],
  [5 / 8, '5/8'], [2 / 3, '2/3'], [3 / 4, '3/4'], [7 / 8, '7/8'],
]

export function formatQuantity(qty, unit) {
  if (qty == null) return ''
  const whole = Math.floor(qty + 1e-9)
  const frac = qty - whole
  const hit = FRACTION_LABELS.find(([value]) => Math.abs(frac - value) < 0.02)

  let number
  if (hit) number = whole ? `${whole} ${hit[1]}` : hit[1]
  else if (Math.abs(qty - Math.round(qty)) < 0.02) number = String(Math.round(qty))
  else number = String(Math.round(qty * 100) / 100)

  if (!unit) return number
  // A metric amount is a decimal, never a fraction: the fraction match above has a
  // tolerance, so 1.35 kg printed as "1 1/3 kg", 17 g short of what was asked for.
  if (systemOf(unit) === 'metric') return `${Math.round(qty * 100) / 100} ${unit}`
  const plural = qty > 1 && UNIT_PLURALS[unit] ? UNIT_PLURALS[unit] : unit
  return `${number} ${UNIT_LABELS[plural] || plural}`
}

// Canonical keys that are not what a person writes.
const UNIT_LABELS = { floz: 'fl oz' }

// The canonical unit a word names ("tablespoons" -> 'tbsp'), or undefined.
export function unitOf(word) {
  return UNIT_LOOKUP.get(String(word).toLowerCase().replace(/\.$/, ''))
}

// A unit as written beside a quantity: plural past one, "fl oz" for floz.
export function unitLabel(unit, qty) {
  const plural = qty > 1 && UNIT_PLURALS[unit] ? UNIT_PLURALS[unit] : unit
  return UNIT_LABELS[plural] || plural
}

// --- Scaling (finding 12) --------------------------------------------------
//
// The rule here is the same one the rest of this file follows: never invent a
// number. A line is scaled only when a quantity can be found at the head of the
// text that is actually on screen, and everything else about the line is left
// exactly as written — the unit's own spelling, the parenthetical can size, the
// "finely chopped" on the end.
//
// That is why this rewrites `raw` rather than rebuilding the line out of
// `readIngredient`'s qty/unit/name. Rebuilding would drop every word the parser
// throws away to make a merge key, and for an AI-structured recipe the stored
// `qty` need not even be the string on the page ("0.5" against "½"). Scaling a
// number that is not the number being displayed is the one failure mode that
// would be invisible until something came out of the oven wrong.

// One quantity token, in the same forms takeQuantity accepts and in the same
// order, longest first: "1 1/2", "1½", "1/2", "½", "1.5".
export const AMOUNT = '(?:\\d+\\s+\\d+\\s*/\\s*\\d+|\\d+\\s*[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]|\\d+\\s*/\\s*\\d+|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]|\\d+(?:\\.\\d+)?)'

// Group 1 is any bullet the line was written with, group 2 the amount, group 3
// the separator of a range and group 4 its high end. A range is matched whole so
// that "2-3 cloves" doubles to "4-6 cloves" rather than collapsing to its low
// end — takeQuantity drops the high end because a shopping list has to commit to
// one number, but a recipe on screen has no reason to.
const LEADING_AMOUNT = new RegExp(`^([-*•\\s]*)(${AMOUNT})(?:(\\s*(?:-|–|—|to)\\s*)(${AMOUNT}))?`)

export function amountValue(token) {
  const [value] = takeQuantity(token.trim())
  return value
}

// A weight or volume in brackets straight after the measuring unit restates the
// same amount ("1 cup (200g) sugar"), so it has to scale with it; left alone, a
// doubled recipe shows the original weight. A bracket after a container or
// straight after the number is the size of each one ("1 can (400 g)",
// "2 (14 oz) cans") and must not scale. Both words are checked against the
// measures, so "(packed)" or "(optional)" never match.
const MEASURES = new Set(['cup', 'tbsp', 'tsp', 'oz', 'lb', 'g', 'kg', 'ml', 'l', 'quart', 'pint', 'gallon'])
const METRIC = new Set(['g', 'ml'])
const BRACKETED = new RegExp(`^(\\s*([A-Za-z]+)\\.?\\s*\\(\\s*)(${AMOUNT})(\\s*([A-Za-z]+)\\.?\\s*\\))`)

// Nobody weighs 337 1/2 g, so grams and millilitres are whole numbers. Under
// ten they keep one decimal, or a quartered "1 g" would round away to "0 g".
function formatMetric(value) {
  return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
}

function measureOf(word) {
  const unit = UNIT_LOOKUP.get(word.toLowerCase())
  return MEASURES.has(unit) ? unit : null
}

function scaleBracketed(rest, factor) {
  const match = rest.match(BRACKETED)
  if (!match || !measureOf(match[2])) return rest
  const unit = measureOf(match[5])
  const value = unit ? amountValue(match[3]) : null
  if (value === null) return rest
  const scaled = METRIC.has(unit) ? formatMetric(value * factor) : formatQuantity(value * factor, null)
  return `${match[1]}${scaled}${match[4]}${rest.slice(match[0].length)}`
}

export function scaleIngredientText(raw, factor) {
  const text = String(raw ?? '')
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return text

  const match = text.match(LEADING_AMOUNT)
  if (!match) return text

  const low = amountValue(match[2])
  if (low === null) return text

  let amount = formatQuantity(low * factor, null)
  if (match[4]) {
    const high = amountValue(match[4])
    // A range whose high end won't parse is left alone entirely. Scaling half of
    // "2 to a few" would read as a fact.
    if (high === null) return text
    amount += `${match[3]}${formatQuantity(high * factor, null)}`
  }

  return `${match[1]}${amount}${scaleBracketed(text.slice(match[0].length), factor)}`
}

// The amount at the head of a line, and its unit when the word after it is one,
// split off so the sheet can set it in bold (every comparable app does, and the
// eye finds "2 cups" before it finds the noun). Nothing is rewritten: the three
// parts always join back into exactly the input, and a line with no quantity at
// its head comes back untouched as `rest`, the same rule scaling follows. A
// bracketed weight ("(200 g)") stays plain: it restates the amount, it is not
// the amount.
export function splitAmount(text) {
  const s = String(text ?? '')
  const match = s.match(LEADING_AMOUNT)
  if (!match) return { lead: '', bold: '', rest: s }
  const lead = match[1]
  let bold = match[0].slice(lead.length)
  const after = s.slice(match[0].length).match(/^(\s*)([A-Za-z]+)\.?(?=\s|$|,)/)
  if (after && unitOf(after[2])) bold += s.slice(match[0].length, match[0].length + after[0].length)
  return { lead, bold, rest: s.slice(lead.length + bold.length) }
}

// Width, in characters, of the quantity column when a recipe's lines are set in
// one: the longest bold amount, capped so a freak line ("1 1/2 to 2 tablespoons")
// cannot take half the screen. 14 holds "2 tablespoons" (13), which is on most
// recipes; a longer one is cut to the cap and the column does not grow for it.
// 0 when no line has an amount, which is the cue to set the list as plain text
// with no column at all.
export const QTY_COLUMN_MAX = 14

export function qtyColumnCh(lines) {
  let longest = 0
  for (const line of lines) longest = Math.max(longest, splitAmount(line).bold.trim().length)
  return Math.min(longest, QTY_COLUMN_MAX)
}

// A shopping line's sources on one line: the first recipe, then "+N" for the
// rest. The full list is in the item's sheet; spelling every recipe out is what
// made each row wrap to three lines.
export function formatSources(sources) {
  if (!sources?.length) return ''
  const first = formatSource(sources[0])
  return sources.length > 1 ? `${first} +${sources.length - 1}` : first
}

// Recipes that came through the AI structurer already carry item/qty/unit, so
// use those and skip the parser. qty arrives as a string there.
function fromStructured(ing) {
  if (!ing.item) return null
  const qty = ing.qty === null || ing.qty === undefined || ing.qty === '' ? null : Number(ing.qty)
  if (Number.isNaN(qty)) return null
  return {
    qty,
    unit: ing.unit ? UNIT_LOOKUP.get(String(ing.unit).toLowerCase()) || null : null,
    name: ing.item,
    raw: ing.raw || ing.item,
    parsed: qty !== null,
  }
}

export function readIngredient(ing) {
  return fromStructured(ing) || parseIngredient(ing.raw)
}

// Collapses the week's planned recipes into merged lines, grouped by aisle.
// Lines that could not be parsed are kept verbatim and never merged.
// `units` is the person's setting: 'original' keeps what the recipes said, 'metric'
// and 'us' write the list in that system.
export function buildShoppingList(plan, recipes, units = 'original') {
  const byId = new Map(recipes.map((r) => [r.id, r]))
  const merged = new Map()

  for (const entry of plan) {
    // Leftovers are a meal eaten from what was cooked earlier: there is nothing to
    // buy for them, so they contribute no lines (and no source name).
    if (entry.leftover) continue
    const recipe = byId.get(entry.recipe_id)
    if (!recipe) continue
    // A meal planned for a different number of servings than the recipe says
    // scales what it asks the list for. No stored servings, or a recipe whose
    // own count can't be read, means 1: the list never invents a ratio. Only the
    // quantity moves; the merge key below is built from name and dimension, so
    // a tick on a line means the same thing at any servings.
    const base = baseServings(recipe)
    const factor = entry.servings && base ? entry.servings / base : 1
    for (const ing of recipe.ingredients || []) {
      const read = readIngredient(ing)
      if (!read) continue
      const parsed = factor === 1 || read.qty === null ? read : { ...read, qty: read.qty * factor }

      // Unparsed lines get a key unique to their text so they stand alone.
      //
      // Within a dimension the unit is NOT part of the key: 1 tsp and 1 tbsp of
      // salt, or 500 g and 1 kg of flour, are one line, because converting between
      // units of the same dimension is exact arithmetic (units.js). That reverses
      // the old rule, which kept every unit apart. What is still never added
      // together is volume and weight (1 cup milk with 200 g milk): that is not
      // arithmetic, it depends on the ingredient, and a quiet error there is only
      // found in the shop.
      const dimension = parsed.parsed ? DIMENSION[parsed.unit] : undefined
      const key = parsed.parsed
        ? `${normalizeName(parsed.name)}|${dimension || parsed.unit || ''}`
        : `raw:${parsed.raw.toLowerCase()}`

      const existing = merged.get(key)
      if (existing) {
        if (parsed.qty !== null) {
          if (dimension && parsed.unit !== existing.unit) existing.mixed = true
          existing.qty = (existing.qty ?? 0) + parsed.qty
          if (dimension) {
            existing.total += toBase(parsed.qty, parsed.unit)
            const system = systemOf(parsed.unit)
            existing.systems[system] = (existing.systems[system] || 0) + 1
          }
        }
        // Per-recipe contributions, so a merged total stays traceable to what
        // asked for it. A recipe planned twice in the week contributes twice,
        // which is correct but looks wrong without the count, hence `times`.
        const source = existing.sources.find((s) => s.title === recipe.title)
        if (source) {
          source.times += 1
          if (parsed.qty !== null) source.qty = (source.qty ?? 0) + parsed.qty
        } else {
          existing.sources.push({
            title: recipe.title,
            qty: parsed.qty,
            unit: parsed.unit,
            times: 1,
          })
        }
      } else {
        const measured = Boolean(dimension) && parsed.qty !== null
        merged.set(key, {
          key,
          name: parsed.name,
          qty: parsed.qty,
          unit: parsed.unit,
          raw: parsed.raw,
          parsed: parsed.parsed,
          // What shopping_prefs files staples and moved aisles under. Null for a
          // line that could not be parsed: it merges with nothing, so there is no
          // "item" to remember a choice about.
          nameKey: parsed.parsed ? normalizeName(parsed.name) : null,
          aisle: aisleFor(parsed.name),
          base: baseFor(parsed.name),
          sources: [{ title: recipe.title, qty: parsed.qty, unit: parsed.unit, times: 1 }],
          // Only for a measure: the running total in grams or millilitres, whether
          // the recipes disagreed about the unit, and which system each used.
          dimension: measured ? dimension : null,
          total: measured ? toBase(parsed.qty, parsed.unit) : null,
          mixed: false,
          systems: measured ? { [systemOf(parsed.unit)]: 1 } : {},
        })
      }
    }
  }

  const items = [...merged.values()]
  for (const item of items) writeInDisplayUnits(item, units)
  return items.sort(
    (a, b) =>
      AISLE_ORDER.indexOf(a.aisle) - AISLE_ORDER.indexOf(b.aisle) ||
      a.name.localeCompare(b.name),
  )
}

// Spoons stay spoons in a metric kitchen: "1 tsp salt" is as metric as it gets,
// and "5 ml salt" is nobody's idea of a recipe.
const SPOONS = new Set(['tsp', 'tbsp'])

// Decides the unit a merged measure is shown in. When the recipes agreed on one
// unit and the person has not asked for another system, it is left exactly as the
// recipes wrote it. Otherwise the total is rewritten at the size a person reads:
// 3 tsp as 1 tbsp, 1500 g as 1.5 kg.
function writeInDisplayUnits(item, units) {
  const total = item.total
  delete item.total
  if (!item.dimension) return
  // The system most of the recipes used; on a tie, the first recipe's, since the
  // plan runs in the order the person laid it out.
  const majority = Object.entries(item.systems).reduce(
    (best, entry) => (entry[1] > best[1] ? entry : best),
    ['metric', 0],
  )[0]

  if (units === 'original') {
    if (!item.mixed) return
    const written = bestUnit(total, item.dimension, majority)
    // Mixed units, so there is nothing "as written" to keep if it is too small.
    Object.assign(item, written.qty > 0 ? written : bestUnit(total, item.dimension, 'metric'))
    return
  }
  if (units === 'metric' && !item.mixed && SPOONS.has(item.unit)) return
  const written = bestUnit(total, item.dimension, units)
  // An amount too small to write in the other system (3 g of saffron is 0.1 oz) is
  // left as the recipes wrote it rather than printed as "0 oz". If the recipes
  // disagreed about the unit there is no "as written" to fall back to (the raw sum
  // is in mixed units), so the total goes in grams or millilitres instead.
  if (written.qty > 0) Object.assign(item, written)
  else if (item.mixed) Object.assign(item, bestUnit(total, item.dimension, 'metric'))
}

// A source line names the recipe, nothing else: "Pasta", or "Pasta ×2" when
// it's planned twice that week. The merged line above it already carries the
// amount (finding 21) — repeating it here was the noisiest text on the
// screen and half of it was a repeat of the bold line above.
export function formatSource(source) {
  const times = source.times > 1 ? ` ×${source.times}` : ''
  return `${source.title}${times}`
}

// Aisle sections, each holding a mix of standalone items and variant groups.
// A base only earns a heading when two or more variants of it are present;
// a lone "2 chicken breasts" reads better as an ordinary line.
export function groupByAisle(items, order = AISLE_ORDER) {
  const byAisle = new Map()
  for (const item of items) {
    if (!byAisle.has(item.aisle)) byAisle.set(item.aisle, [])
    byAisle.get(item.aisle).push(item)
  }

  return order.filter((aisle) => byAisle.has(aisle)).map((aisle) => {
    const aisleItems = byAisle.get(aisle)

    const counts = new Map()
    for (const item of aisleItems) {
      if (item.base) counts.set(item.base, (counts.get(item.base) || 0) + 1)
    }

    const entries = []
    const emitted = new Set()
    for (const item of aisleItems) {
      const grouped = item.base && counts.get(item.base) > 1
      if (!grouped) {
        entries.push({ type: 'item', key: item.key, item, sortName: item.name })
        continue
      }
      if (emitted.has(item.base)) continue
      emitted.add(item.base)
      entries.push({
        type: 'group',
        key: `base:${item.base}`,
        base: item.base,
        items: aisleItems.filter((i) => i.base === item.base),
        sortName: item.base,
      })
    }

    return {
      aisle,
      entries: entries.sort((a, b) => a.sortName.localeCompare(b.sortName)),
    }
  })
}

// Lays the person's shopping_prefs over the derived lines: an item they moved
// goes to the aisle they chose, and a staple is flagged so the list can fold it
// away. `defaultAisle` keeps what the keyword list said, which is what "put it
// back" compares against. Nothing here touches `key`, so ticks are unaffected.
export function applyPrefs(items, prefs) {
  const staples = new Set(prefs?.staples || [])
  const moved = prefs?.aisle_map || {}
  return items.map((item) => ({
    ...item,
    defaultAisle: item.aisle,
    aisle: (item.nameKey && moved[item.nameKey]) || item.aisle,
    staple: Boolean(item.nameKey) && staples.has(item.nameKey),
  }))
}

// One line as the list shows it, for sharing as text.
function lineText(item) {
  if (!item.parsed) return item.raw
  return [formatQuantity(item.qty, item.unit), item.name].filter(Boolean).join(' ')
}

// The list as plain text for the share sheet or the clipboard. It is what is
// still to buy: picked lines and staples are left out, since whoever is at the
// shop has no use for either. Aisle headings keep the order the list shows.
export function shoppingText({ label, groups, manual, isPicked }) {
  const out = []
  for (const { aisle, entries } of groups) {
    const lines = []
    for (const entry of entries) {
      const items = entry.type === 'group' ? entry.items : [entry.item]
      for (const item of items) if (!item.staple && !isPicked(item.key)) lines.push(`- ${lineText(item)}`)
    }
    if (lines.length) out.push(aisle, ...lines, '')
  }
  const own = manual.filter((row) => !row.checked)
  if (own.length) out.push('Added by you', ...own.map((row) => `- ${row.name}`), '')
  if (out.length === 0) return ''
  return [label, '', ...out].join('\n').trimEnd()
}
