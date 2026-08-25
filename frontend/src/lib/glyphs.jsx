// What fills the image box when there is no photo.
//
// This is not an edge case. Pasted text and typed recipes never have an image,
// link cards often don't, and the ones that do lose it eventually: Instagram and
// TikTok serve signed CDN URLs that expire, and plenty of sites block hotlinking
// outright with Cross-Origin-Resource-Policy, which has no client-side
// workaround. So the box needs something to show that isn't a broken-image icon.
//
// Two layers. A line glyph when one of the recipe's tags maps to one, which is
// cheap only because the AI tag vocabulary is closed (see ALLOWED_TAGS in
// backend/app/tags.py) — a finite tag list means a finite glyph list. Otherwise a
// monogram of the first letter, on a colour picked from the title.
//
// No survey of comparable apps helped here: their marketing screenshots only ever
// show fully photographed libraries, and the one precedent found across eleven
// apps was Pestle's source-initial badge, which still sits over a real photo.

// Order matters. The first tag on a recipe that appears in this list wins, so the
// more specific kinds of dish come before the broad meal names — a recipe tagged
// ["dinner", "soup"] should read as soup, not as dinner.
const GLYPH_ORDER = [
  'soup',
  'salad',
  'pasta',
  'pizza',
  'sandwich',
  'bread',
  'drink',
  'sauce',
  'dessert',
  'seafood',
  'eggs',
  'chicken',
  'beef',
  'pork',
  'beans',
  'tofu',
  'breakfast',
  'snack',
  'side',
  'grilled',
  'baked',
  'no-cook',
]

// Several tags share a drawing: a glyph set where beef and pork are subtly
// different silhouettes at 54px is a glyph set nobody can read.
const GLYPH_FOR = {
  soup: 'bowl',
  salad: 'leaf',
  pasta: 'bowl',
  pizza: 'slice',
  sandwich: 'sandwich',
  bread: 'loaf',
  drink: 'glass',
  sauce: 'jar',
  dessert: 'cake',
  seafood: 'fish',
  eggs: 'egg',
  chicken: 'drumstick',
  beef: 'steak',
  pork: 'steak',
  beans: 'leaf',
  tofu: 'leaf',
  breakfast: 'egg',
  snack: 'jar',
  side: 'bowl',
  grilled: 'flame',
  baked: 'loaf',
  'no-cook': 'leaf',
}

// Drawn on a 48×48 grid, stroked not filled, so one weight reads at any size.
const PATHS = {
  bowl: (
    <>
      <path d="M6 20h36" />
      <path d="M9 20c0 12 4 21 15 21s15-9 15-21" />
      <path d="M17 14c1-3 5-3 6-6" />
      <path d="M27 14c1-3 5-3 6-6" />
    </>
  ),
  leaf: (
    <>
      <path d="M24 42V20" />
      <path d="M24 20c0-8 6-14 16-14 0 10-6 16-16 16Z" />
      <path d="M24 26c0-7-5-12-14-12 0 9 5 14 14 14Z" />
    </>
  ),
  slice: (
    <>
      <path d="M24 6 42 40c-11 5-25 5-36 0Z" />
      <circle cx="24" cy="22" r="2.4" />
      <circle cx="18" cy="32" r="2.4" />
      <circle cx="30" cy="32" r="2.4" />
    </>
  ),
  sandwich: (
    <>
      <path d="M7 20c0-6 8-10 17-10s17 4 17 10Z" />
      <path d="M7 24h34" />
      <path d="M9 30h30c0 5-4 8-15 8S9 35 9 30Z" />
    </>
  ),
  loaf: (
    <>
      <path d="M9 24c0-8 6-14 15-14s15 6 15 14" />
      <path d="M6 24h36l-3 15H9Z" />
      <path d="M24 10V5" />
    </>
  ),
  glass: (
    <>
      <path d="M14 8h20l-3 32H17Z" />
      <path d="M15 18h18" />
    </>
  ),
  jar: (
    <>
      <path d="M16 6h16v6H16Z" />
      <path d="M13 12h22v26a4 4 0 0 1-4 4H17a4 4 0 0 1-4-4Z" />
      <path d="M13 24h22" />
    </>
  ),
  cake: (
    <>
      <path d="M10 22h28v18H10Z" />
      <path d="M10 30c4 3 8 3 12 0s8-3 12 0" />
      <path d="M24 22v-6" />
      <path d="M24 12v-4" />
    </>
  ),
  fish: (
    <>
      <path d="M6 24c6-8 14-12 22-12s14 4 14 12-6 12-14 12S12 32 6 24Z" />
      <path d="M6 24c4-2 8-2 12 0" />
      <circle cx="33" cy="21" r="1.6" />
    </>
  ),
  egg: (
    <>
      <path d="M24 6c7 0 12 10 12 19a12 12 0 0 1-24 0C12 16 17 6 24 6Z" />
      <circle cx="24" cy="26" r="5" />
    </>
  ),
  drumstick: (
    <>
      <path d="M28 8a11 11 0 0 1 8 18l-4 4-8-8 4-4a11 11 0 0 1 0-10Z" />
      <path d="M22 24 10 36" />
      <path d="M14 32l-4 8 8-4" />
    </>
  ),
  steak: (
    <>
      <path d="M8 22c0-9 8-14 18-14s14 5 14 12-6 14-16 14S8 30 8 22Z" />
      <path d="M18 20c3-3 8-3 11 0" />
    </>
  ),
  flame: (
    <>
      <path d="M24 6c8 8 12 13 12 20a12 12 0 0 1-24 0c0-5 3-9 6-12 1 4 3 5 4 3 1-3 1-7 2-11Z" />
    </>
  ),
}

// These used to be saturated: a 128px block of solid colour with a white letter
// on it, which pulled the eye harder than any of the real photographs beside it
// (finding 8). The recipe carrying the least information looked like the most
// important thing in the list, and a two-column grid only makes that louder,
// since the tile now holds a whole cell rather than a thumbnail.
//
// So the treatment is inverted rather than dropped. Same six hues, same
// title-derived pick, but as tints of the page ground with the ink dark on top,
// and the tile's edge carried by a hairline instead of by the fill. Measured
// against the tokens they sit between: each tint clears 13.6:1 against --txt
// (the glyph and monogram now), sits 1.06–1.12 off --ground so it reads as a
// tile at all, and leaves --line 1.10–1.16 darker than the fill so the hairline
// is visible from inside as well as against the page.
const TILE_TINTS = [
  '#e3ece2',
  '#f2e6d6',
  '#e2e9f0',
  '#ece2ec',
  '#f2e3e3',
  '#e8edd9',
]

export function glyphNameFor(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return null
  const owned = new Set(tags)
  const match = GLYPH_ORDER.find((tag) => owned.has(tag))
  return match ? GLYPH_FOR[match] : null
}

// Stable across reloads and devices because it only reads the title: the same
// recipe keeps its tint, and two recipes next to each other rarely share one.
export function tileTint(title) {
  let hash = 0
  for (let i = 0; i < (title || '').length; i += 1) {
    hash = (hash * 31 + title.charCodeAt(i)) % 100000
  }
  return TILE_TINTS[hash % TILE_TINTS.length]
}

export function monogramLetter(title) {
  // Skip anything that isn't a letter or digit so "…and Rice" doesn't become an
  // ellipsis and "3-Ingredient Pasta" keeps its 3.
  const match = (title || '').match(/[\p{L}\p{N}]/u)
  return match ? match[0].toUpperCase() : '?'
}

// aria-hidden throughout: the recipe title sits directly beside this, so naming
// the glyph would only make a screen reader say the same thing twice.
export function TagGlyph({ name }) {
  const paths = PATHS[name]
  if (!paths) return null
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths}
    </svg>
  )
}
