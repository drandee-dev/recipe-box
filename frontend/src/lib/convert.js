// Showing a recipe in the units a person cooks in (Phase B). Display only: nothing
// here is ever written back, so a recipe stays exactly as it was saved and
// switching the setting back always returns it.
//
// It rewrites the line that is on screen rather than rebuilding it from parsed
// fields, for the same reason the scaler does (see scaleIngredientText): the
// words around the quantity ("finely chopped", "(packed)") are not ours to lose,
// and a number rebuilt from `qty` need not be the one being displayed.
//
// A line is only touched when it starts with a quantity and a measuring unit.
// Anything else comes back as written. A conversion that cannot be done exactly
// either does not happen (a cup of chopped walnuts stays a cup) or is labelled as
// approximate with "≈" (a cup of flour is about 125 g).

import { AMOUNT, amountValue, formatQuantity, scaleIngredientText, unitLabel, unitOf } from './ingredients.js'
import {
  CUP_STEPS,
  DIMENSION,
  bestUnit,
  celsiusToFahrenheit,
  fahrenheitToCelsius,
  fromBase,
  metricMass,
  nearestFraction,
  roundMass,
  systemOf,
  toBase,
} from './units.js'

export const UNIT_MODES = ['original', 'metric', 'us']

// Bullet, amount, an optional range, then the unit: a word, or "fl oz".
const LINE = new RegExp(
  `^([-*•\\s]*)(${AMOUNT})(?:(\\s*(?:-|–|—|to)\\s*)(${AMOUNT}))?\\s*(fl\\.?\\s*oz\\.?|fluid\\s+ounces?|[A-Za-z]+\\.?)(?=[\\s(]|$)`,
  'i',
)

// "1 cup (200g) sugar": a measure in brackets straight after the measure restates
// the same amount in the other system.
const RESTATED = new RegExp(`^\\s*\\(\\s*(${AMOUNT})\\s*([A-Za-z]+)\\.?\\s*\\)`)

// Grams in a US cup, for the baking staples where recipes in the two systems
// really do use different units. Approximate by nature (how the flour was
// scooped), which is why anything made from it is marked "≈". Listed on purpose
// and short: an ingredient not here stays as written rather than guessed at.
const DRY = [
  [/\b(?:brown sugar)\b/, 213],
  [/\b(?:powdered|icing|confectioners'?|confectioner's) sugar\b/, 120],
  [/\b(?:granulated |caster |white )?sugar\b/, 200, /coconut|maple|palm|vanilla|cinnamon|syrup|snap/],
  [/\bflour\b/, 125, /almond|coconut|oat|rice|chickpea|buckwheat|corn|potato|tapioca|cassava|rye|spelt|gluten|semolina|masa|besan/],
  [/\b(?:rolled |old[- ]fashioned |quick )?oats\b/, 90],
  [/\brice\b/, 185, /flour|vinegar|milk|noodle|cooked|wine|krispies|paper|cake|syrup/],
]
const BUTTER = /\bbutter\b/
const NOT_BUTTER = /peanut|almond|nut|cashew|shea|cocoa|buttermilk|butterscotch|apple|bean|squash/
const LIQUID = /\b(?:water|milk|buttermilk|cream|half[- ]and[- ]half|broth|stock|juice|vinegar|oil|wine|beer|coffee)\b/
const NOT_LIQUID = /cheese|oil-packed|chocolate|of tartar|powder|ice cream|whipped/

// What the ingredient is, from the words after the unit up to the first comma.
function densityFor(rest) {
  const name = rest.split(',')[0].toLowerCase()
  for (const [pattern, grams, except] of DRY) {
    if (pattern.test(name) && !(except && except.test(name))) return { kind: 'weight', gPerCup: grams, keep: false }
  }
  if (BUTTER.test(name) && !NOT_BUTTER.test(name)) return { kind: 'weight', gPerCup: 227, keep: true }
  if (LIQUID.test(name) && !NOT_LIQUID.test(name)) return { kind: 'liquid' }
  return null
}

// Round a quantity the way a person writes it in that unit.
function roundIn(value, unit) {
  if (unit === 'g') return roundMass(value)
  if (unit === 'ml') return value < 20 ? Math.max(1, Math.round(value)) : Math.round(value / 5) * 5
  if (unit === 'kg') return Math.round(Math.round(value / 0.05) * 0.05 * 100) / 100
  if (unit === 'l') return Math.round(value * 100) / 100
  if (unit === 'oz' && value >= 4) return Math.round(value * 2) / 2
  if (unit === 'oz' || unit === 'lb' || unit === 'quart') return nearestFraction(value, [0, 1 / 4, 1 / 2, 3 / 4, 1])
  return nearestFraction(value, unit === 'cup' ? CUP_STEPS : undefined)
}

function number(qty, unit) {
  return systemOf(unit) === 'metric' ? String(qty) : formatQuantity(qty, null)
}

// What a quantity in one unit becomes in the mode, as { qty, unit, approx } for the
// low end, or null to leave the line alone.
function target(qty, unit, mode, rest) {
  const system = systemOf(unit)
  if (system === mode) return null
  // Spoons are as metric as they get: "1 tsp salt" stays, not "5 ml salt".
  if (mode === 'metric' && (unit === 'tsp' || unit === 'tbsp')) return null

  const base = toBase(qty, unit)
  const dimension = DIMENSION[unit]

  if (mode === 'metric') {
    if (unit === 'cup') {
      const density = densityFor(rest)
      if (!density) return null
      if (density.kind === 'liquid') return { ...bestUnit(base, 'volume', 'metric'), approx: false }
      return { ...metricMass(qty * density.gPerCup), approx: true }
    }
    return { ...bestUnit(base, dimension, 'metric'), approx: false }
  }

  // mode === 'us', from grams, kilograms, millilitres or litres.
  if (dimension === 'mass') {
    const density = densityFor(rest)
    if (density && density.kind === 'weight' && !density.keep) {
      return { qty: nearestFraction(base / density.gPerCup), unit: 'cup', approx: true }
    }
    return { ...bestUnit(base, 'mass', 'us'), approx: false }
  }
  return { ...bestUnit(base, 'volume', 'us', { coarse: true }), approx: false }
}

// One quantity, its range, and the unit once: "2-3 cups", "1 1/2 to 2 lb".
function write(bullet, low, high, sep, unit, approx) {
  const range = high === null ? '' : `${sep}${number(high, unit)}`
  const star = approx ? '≈' : ''
  return `${bullet}${star}${number(low, unit)}${range} ${unitLabel(unit, high ?? low)}`
}

export function convertLine(text, mode) {
  if (mode !== 'metric' && mode !== 'us') return text
  const m = String(text ?? '').match(LINE)
  if (!m) return text

  const unit = m[5].match(/^(?:fl|fluid)/i) ? 'floz' : unitOf(m[5])
  if (!unit || !DIMENSION[unit]) return text

  const low = amountValue(m[2])
  const high = m[4] ? amountValue(m[4]) : null
  if (low === null || (m[4] && high === null)) return text

  let rest = text.slice(m[0].length)

  // "1 cup (200g) sugar": the bracket is the same amount in the other system. If
  // it is already in the one asked for, use it and drop the first; if the
  // main amount already is, the line is as it should be.
  const restated = rest.match(RESTATED)
  if (restated) {
    const inner = unitOf(restated[2])
    if (inner && DIMENSION[inner]) {
      const value = amountValue(restated[1])
      if (value !== null && systemOf(inner) === mode && systemOf(unit) !== mode) {
        return `${m[1]}${number(value, inner)} ${unitLabel(inner, value)}${rest.slice(restated[0].length)}`
      }
      if (systemOf(unit) === mode) return text
      rest = rest.slice(restated[0].length)
    }
  }

  const to = target(low, unit, mode, rest)
  if (!to) return text

  // The high end is brought into the low end's unit, so a range never reads
  // "2 cups to 1 quart". An approximate conversion scales the low end's answer by
  // the ratio, so both ends use the same density; an exact one converts directly.
  let toHigh = null
  if (high !== null) {
    toHigh = to.approx
      ? roundIn((high / low) * to.qty, to.unit)
      : roundIn(fromBase(toBase(high, unit), to.unit), to.unit)
  }
  return `${write(m[1], to.qty, toHigh, m[3], to.unit, to.approx)}${rest}`
}

// --- Oven temperatures in step text -----------------------------------------

const TEMP = /(\d{2,3})(?:(\s*(?:-|–|—|to)\s*)(\d{2,3}))?(\s*(?:°|º|˚|degrees?)\s*)([FC])\b/gi

export function convertTemperatures(text, mode) {
  if (mode !== 'metric' && mode !== 'us') return text
  const source = String(text ?? '')
  const found = [...source.matchAll(TEMP)]
  const want = mode === 'metric' ? 'C' : 'F'

  return found.reduceRight((out, match, i) => {
    const unit = match[5].toUpperCase()
    if (unit === want) return out
    // "180°C/350°F" and "350°F (175°C)" already say it both ways; converting one
    // half would print the same temperature twice.
    const neighbours = [found[i - 1], found[i + 1]].filter(Boolean)
    const paired = neighbours.some((other) => {
      const gap = other.index < match.index
        ? match.index - (other.index + other[0].length)
        : other.index - (match.index + match[0].length)
      return other[5].toUpperCase() === want && gap >= 0 && gap <= 4
    })
    if (paired) return out
    const convert = mode === 'metric' ? fahrenheitToCelsius : celsiusToFahrenheit
    const lowTemp = convert(Number(match[1]))
    const range = match[3] ? `${match[2]}${convert(Number(match[3]))}` : ''
    // Written as 175°C whatever the source used for the degree ("degrees", º).
    return `${out.slice(0, match.index)}${lowTemp}${range}°${want}${out.slice(match.index + match[0].length)}`
  }, source)
}

// The one call the screens make for an ingredient line: scale it, then convert it.
export function displayIngredient(raw, { factor = 1, units = 'original' } = {}) {
  return convertLine(scaleIngredientText(raw, factor), units)
}
