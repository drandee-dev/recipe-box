// Units and exact arithmetic between them (Phase B). Pure numbers: it imports
// nothing, so the ingredient parser, the line converter and the shopping list can
// all lean on it without a cycle.
//
// Two dimensions convert, and only within themselves: mass (g, kg, oz, lb) and
// volume (ml, l, tsp, tbsp, fl oz, cup, pint, quart, gallon). Volume to mass is
// never done here, because it is not arithmetic: it depends on what the
// ingredient is, and a quiet error there is found in the oven. convert.js does
// that for a short list of baking staples, labelled as approximate.
//
// Kitchen metric, not laboratory metric. A US cup is 236.59 ml, and a recipe that
// says "1 cup" and gets "236.59 ml" is a worse answer than 240. The factors are
// the round ones every metric cookbook uses (5, 15, 30, 240), which also keeps
// 3 tsp equal to exactly 1 tbsp, so adding spoons up does not drift.

// Measure units and the spellings seen in real recipes. ingredients.js builds its
// canonical-unit table from this so the two cannot disagree about what a "tbsp"
// is. "fl oz" is two words and is handled where the unit is read.
export const MEASURE_ALIASES = {
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
}

// Grams and millilitres are the base units each dimension is added up in.
const GRAMS = { g: 1, kg: 1000, oz: 28.35, lb: 453.6 }
const MILLILITRES = { ml: 1, l: 1000, tsp: 5, tbsp: 15, floz: 30, cup: 240, pint: 480, quart: 960, gallon: 3840 }

export const DIMENSION = {}
for (const unit of Object.keys(GRAMS)) DIMENSION[unit] = 'mass'
for (const unit of Object.keys(MILLILITRES)) DIMENSION[unit] = 'volume'

export const US_UNITS = new Set(['tsp', 'tbsp', 'floz', 'cup', 'pint', 'quart', 'gallon', 'oz', 'lb'])
export const METRIC_UNITS = new Set(['g', 'kg', 'ml', 'l'])

export function systemOf(unit) {
  if (US_UNITS.has(unit)) return 'us'
  if (METRIC_UNITS.has(unit)) return 'metric'
  return null
}

// A quantity in the base unit of its dimension, or null if the unit does not
// convert (a clove, a can).
export function toBase(qty, unit) {
  const factor = GRAMS[unit] ?? MILLILITRES[unit]
  return factor === undefined ? null : qty * factor
}

// The other direction: a base quantity written in a given unit.
export function fromBase(base, unit) {
  return base / (GRAMS[unit] ?? MILLILITRES[unit])
}

// Fractions a person would actually measure with, and the nearest one to a value.
// Thirds are in because a third of a cup is a real measure and rounding it to an
// eighth is a 7% error on every recipe that uses one.
const STEPS = [0, 1 / 8, 1 / 4, 1 / 3, 3 / 8, 1 / 2, 5 / 8, 2 / 3, 3 / 4, 7 / 8, 1]

export function nearestFraction(value, steps = STEPS) {
  const whole = Math.floor(value)
  const frac = value - whole
  let best = steps[0]
  for (const step of steps) if (Math.abs(step - frac) < Math.abs(best - frac)) best = step
  return whole + best
}

function round(value, step) {
  return Math.round(value / step) * step
}

// Nobody weighs 337 grams of anything. Fine steps while it is small, and kilograms
// once it is big, so 1500 g reads "1.5 kg".
export function roundMass(grams) {
  if (grams < 20) return Math.max(1, Math.round(grams))
  // Steps of 25 from a quarter kilo up: a pound is 450 g on every packet, not 455.
  return grams >= 250 ? round(grams, 25) : round(grams, 5)
}

export function metricMass(grams) {
  if (grams >= 1000) return { qty: Math.round(round(grams / 1000, 0.05) * 100) / 100, unit: 'kg' }
  return { qty: roundMass(grams), unit: 'g' }
}

export function metricVolume(ml) {
  if (ml >= 1000) return { qty: Math.round((ml / 1000) * 100) / 100, unit: 'l' }
  if (ml < 20) return { qty: Math.max(1, Math.round(ml)), unit: 'ml' }
  return { qty: round(ml, 5), unit: 'ml' }
}

export function usMass(grams) {
  const oz = grams / GRAMS.oz
  if (oz >= 16) return { qty: nearestFraction(oz / 16, [0, 1 / 4, 1 / 2, 3 / 4, 1]), unit: 'lb' }
  // Under a quarter ounce (about 7 g) there is no useful US measure for it: grams
  // are what a pinch of saffron or salt is weighed in. A quantity of 0 tells the
  // callers to leave the amount as written. Above that, eighths: yeast and spices
  // are a few grams, where a quarter is a third out.
  if (oz < 0.25) return { qty: 0, unit: 'oz' }
  if (oz < 4) return { qty: nearestFraction(oz), unit: 'oz' }
  return { qty: Math.round(oz * 2) / 2, unit: 'oz' }
}

// The unit a person would reach for at this size, so 20 ml is a tablespoon and a
// third and 3 tsp becomes 1 tbsp rather than "3 tsp".
// Cups in the steps a cup is measured in. A recipe line wants these (500 ml is
// "2 cups", not "2 1/8"); a shopping total uses every eighth, so the rounding
// error on what to buy stays as small as the measures allow. Both round to the
// nearest step, so a total can be a few percent either side.
export const CUP_STEPS = [0, 1 / 4, 1 / 3, 3 / 8, 1 / 2, 5 / 8, 2 / 3, 3 / 4, 7 / 8, 1]

export function usVolume(ml, { coarse = false } = {}) {
  if (ml >= MILLILITRES.quart) {
    return { qty: nearestFraction(ml / MILLILITRES.quart, [0, 1 / 4, 1 / 2, 3 / 4, 1]), unit: 'quart' }
  }
  if (ml >= 59) return { qty: nearestFraction(ml / MILLILITRES.cup, coarse ? CUP_STEPS : STEPS), unit: 'cup' }
  if (ml >= 14) return { qty: nearestFraction(ml / MILLILITRES.tbsp), unit: 'tbsp' }
  return { qty: nearestFraction(ml / MILLILITRES.tsp), unit: 'tsp' }
}

// A base quantity written in the units of a system, at the size a person reads.
export function bestUnit(base, dimension, system, options) {
  if (dimension === 'mass') return system === 'us' ? usMass(base) : metricMass(base)
  return system === 'us' ? usVolume(base, options) : metricVolume(base)
}

// --- Temperature -----------------------------------------------------------
//
// Oven dials move in fives, and recipes use a fixed set of pairs that are not the
// arithmetic ones (180 C is 356 F; every cookbook says 350). Those pairs first,
// rounded to five otherwise. The table starts at a moderate oven: this runs on
// every temperature in a step, and 100 C is boiling (212 F), not an oven.
const F_TO_C = { 250: 120, 275: 140, 300: 150, 325: 165, 350: 175, 375: 190, 400: 200, 425: 220, 450: 230, 475: 245, 500: 260 }
const C_TO_F = { 120: 250, 130: 265, 140: 275, 150: 300, 160: 325, 170: 340, 175: 350, 180: 350, 190: 375, 200: 400, 210: 410, 220: 425, 230: 450, 240: 465, 245: 475, 250: 480, 260: 500 }

export function fahrenheitToCelsius(f) {
  return F_TO_C[f] ?? Math.round((((f - 32) * 5) / 9) / 5) * 5
}

export function celsiusToFahrenheit(c) {
  return C_TO_F[c] ?? Math.round(((c * 9) / 5 + 32) / 5) * 5
}
