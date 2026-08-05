// Ingredient parsing, merging and aisle grouping for the shopping list.
//
// This has to work hard because extract.py leaves item/qty/unit null on every
// JSON-LD import, so for most saved recipes the only thing available is the
// raw line. Recipes that came through the AI structurer already have the
// fields filled and skip the parser entirely.
//
// The rule throughout: never lose information. Anything that cannot be parsed
// is carried to the list verbatim and simply doesn't merge with anything.

const VULGAR = {
  '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
}

// Canonical unit to the spellings seen in real recipes. Merging happens on the
// canonical form, so "2 tablespoons" and "1 tbsp" add up.
const UNIT_ALIASES = {
  cup: ['cup', 'cups', 'c'],
  tbsp: ['tbsp', 'tbsps', 'tbs', 'tb', 'tablespoon', 'tablespoons'],
  tsp: ['tsp', 'tsps', 'teaspoon', 'teaspoons'],
  oz: ['oz', 'ounce', 'ounces'],
  lb: ['lb', 'lbs', 'pound', 'pounds'],
  g: ['g', 'gr', 'gram', 'grams'],
  kg: ['kg', 'kilogram', 'kilograms'],
  ml: ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres'],
  l: ['l', 'liter', 'liters', 'litre', 'litres'],
  quart: ['quart', 'quarts', 'qt'],
  pint: ['pint', 'pints', 'pt'],
  gallon: ['gallon', 'gallons', 'gal'],
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

function takeUnit(text) {
  const match = text.match(/^([a-zA-Z]+)\.?\s+/)
  if (!match) return [null, text]
  const canonical = UNIT_LOOKUP.get(match[1].toLowerCase())
  if (!canonical) return [null, text]
  return [canonical, text.slice(match[0].length)]
}

// Merge keys only. Display always uses what the recipe actually said.
function singular(word) {
  if (word.length <= 3) return word
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (/(ch|sh|s|x|z)es$/.test(word)) return word.slice(0, -2)
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
  const plural = qty > 1 && UNIT_PLURALS[unit] ? UNIT_PLURALS[unit] : unit
  return `${number} ${plural}`
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
export function buildShoppingList(plan, recipes) {
  const byId = new Map(recipes.map((r) => [r.id, r]))
  const merged = new Map()

  for (const entry of plan) {
    const recipe = byId.get(entry.recipe_id)
    if (!recipe) continue
    for (const ing of recipe.ingredients || []) {
      const parsed = readIngredient(ing)
      if (!parsed) continue

      // Unparsed lines get a key unique to their text so they stand alone.
      // Units are part of the key on purpose: 1 cup milk and 200 ml milk are
      // not added together, because converting between them invites the kind
      // of quiet arithmetic error you only notice in the shop.
      const key = parsed.parsed
        ? `${normalizeName(parsed.name)}|${parsed.unit || ''}`
        : `raw:${parsed.raw.toLowerCase()}`

      const existing = merged.get(key)
      if (existing) {
        if (parsed.qty !== null) existing.qty = (existing.qty ?? 0) + parsed.qty
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
        merged.set(key, {
          key,
          name: parsed.name,
          qty: parsed.qty,
          unit: parsed.unit,
          raw: parsed.raw,
          parsed: parsed.parsed,
          aisle: aisleFor(parsed.name),
          base: baseFor(parsed.name),
          sources: [{ title: recipe.title, qty: parsed.qty, unit: parsed.unit, times: 1 }],
        })
      }
    }
  }

  return [...merged.values()].sort(
    (a, b) =>
      AISLE_ORDER.indexOf(a.aisle) - AISLE_ORDER.indexOf(b.aisle) ||
      a.name.localeCompare(b.name),
  )
}

// A source line: "Pasta 2 cups", or "Pasta ×2 4 cups" when the recipe is
// planned twice that week, or just "Pasta" when nothing parsed.
export function formatSource(source) {
  const times = source.times > 1 ? ` ×${source.times}` : ''
  const amount = source.qty !== null ? ` ${formatQuantity(source.qty, source.unit)}` : ''
  return `${source.title}${times}${amount}`
}

// Aisle sections, each holding a mix of standalone items and variant groups.
// A base only earns a heading when two or more variants of it are present;
// a lone "2 chicken breasts" reads better as an ordinary line.
export function groupByAisle(items) {
  const byAisle = new Map()
  for (const item of items) {
    if (!byAisle.has(item.aisle)) byAisle.set(item.aisle, [])
    byAisle.get(item.aisle).push(item)
  }

  return AISLE_ORDER.filter((aisle) => byAisle.has(aisle)).map((aisle) => {
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
