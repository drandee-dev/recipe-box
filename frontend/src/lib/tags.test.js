// Tests for the tag vocabulary and the search the Recipes tab runs on.
//
// The parity test at the bottom is the one worth having: the vocabulary here is
// a hand-maintained copy of ALLOWED_TAGS in backend/app/tags.py, and the two
// drifting apart fails silently in both directions — a tag added only to the
// backend never appears as a suggestion, and one added only here is a
// suggestion the model is schema-forbidden from ever producing.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { TAG_VOCABULARY, filterRecipes, normalizeTag, tagCounts } from './tags.js'

function recipe(fields) {
  return {
    id: fields.id || 'r1',
    title: fields.title || 'Untitled',
    description: fields.description || '',
    tags: fields.tags || [],
    favorite: Boolean(fields.favorite),
    source_url: fields.source_url || null,
    instructions: fields.instructions || [],
    ingredients: (fields.ingredients || []).map((raw) => ({ raw })),
  }
}

// ---------------------------------------------------------------------------
// normalizeTag
// ---------------------------------------------------------------------------

test('a hand-typed tag gets the same shape as a vocabulary one', () => {
  assert.equal(normalizeTag('  Air Fryer '), 'air-fryer')
  assert.equal(normalizeTag('one   pot'), 'one-pot')
  assert.equal(normalizeTag('MEAL-PREP'), 'meal-prep')
})

test('punctuation is dropped rather than hyphenated', () => {
  assert.equal(normalizeTag("Mum's Recipe"), 'mums-recipe')
  assert.equal(normalizeTag('--gluten--free--'), 'gluten-free')
})

test('a tag that normalizes to nothing is empty, not a stray hyphen', () => {
  assert.equal(normalizeTag('!!!'), '')
  assert.equal(normalizeTag('   '), '')
  assert.equal(normalizeTag(null), '')
})

test('tags are capped in length', () => {
  assert.equal(normalizeTag('a'.repeat(50)).length, 30)
})

// ---------------------------------------------------------------------------
// tagCounts — what the filter chips are built from
// ---------------------------------------------------------------------------

test('counts are most-used first, ties broken alphabetically', () => {
  const recipes = [
    recipe({ tags: ['chicken', 'quick'] }),
    recipe({ tags: ['chicken'] }),
    recipe({ tags: ['baked'] }),
  ]
  assert.deepEqual(tagCounts(recipes), [
    { tag: 'chicken', count: 2 },
    { tag: 'baked', count: 1 },
    { tag: 'quick', count: 1 },
  ])
})

test('a box with no tags produces no chips', () => {
  assert.deepEqual(tagCounts([recipe({}), recipe({})]), [])
})

// ---------------------------------------------------------------------------
// filterRecipes — terms are ANDed
// ---------------------------------------------------------------------------

test('terms narrow rather than widen, and need not share a field', () => {
  const target = recipe({ id: 'a', title: 'Roast chicken', tags: ['quick'] })
  const other = recipe({ id: 'b', title: 'Roast beef', tags: ['quick'] })

  const got = filterRecipes([target, other], { query: 'chicken quick' })
  assert.deepEqual(got.map((r) => r.id), ['a'])
})

test('ingredients are searchable', () => {
  const recipes = [
    recipe({ id: 'a', title: 'Lasagne', ingredients: ['2 cups ricotta'] }),
    recipe({ id: 'b', title: 'Soup', ingredients: ['1 onion'] }),
  ]
  assert.deepEqual(filterRecipes(recipes, { query: 'ricotta' }).map((r) => r.id), ['a'])
})

test('instructions are deliberately not searchable', () => {
  // Step text is full of words nearly every recipe contains, and with ANDed
  // terms including it would make each term match more rather than narrow.
  const recipes = [recipe({ id: 'a', title: 'Soup', instructions: ['Stir until thickened'] })]
  assert.deepEqual(filterRecipes(recipes, { query: 'thickened' }), [])
})

test('the source hostname is searchable, because that is how links are remembered', () => {
  const recipes = [
    recipe({ id: 'a', title: 'Cake', source_url: 'https://www.allrecipes.com/recipe/123' }),
    recipe({ id: 'b', title: 'Pie', source_url: 'https://example.com/pie' }),
  ]
  assert.deepEqual(filterRecipes(recipes, { query: 'allrecipes' }).map((r) => r.id), ['a'])
})

test('a stored URL that no longer parses does not break search', () => {
  const recipes = [recipe({ id: 'a', title: 'Cake', source_url: 'not a url' })]
  assert.doesNotThrow(() => filterRecipes(recipes, { query: 'cake' }))
  assert.equal(filterRecipes(recipes, { query: 'cake' }).length, 1)
})

test('tag filters are ANDed too', () => {
  const recipes = [
    recipe({ id: 'a', tags: ['chicken', 'quick'] }),
    recipe({ id: 'b', tags: ['chicken'] }),
  ]
  assert.deepEqual(filterRecipes(recipes, { tags: ['chicken', 'quick'] }).map((r) => r.id), ['a'])
})

test('favorites-only and an empty query', () => {
  const recipes = [recipe({ id: 'a', favorite: true }), recipe({ id: 'b' })]
  assert.deepEqual(filterRecipes(recipes, { favoritesOnly: true }).map((r) => r.id), ['a'])
  assert.equal(filterRecipes(recipes, {}).length, 2)
  assert.equal(filterRecipes(recipes).length, 2)
})

// ---------------------------------------------------------------------------
// The invariant that is otherwise only a comment
// ---------------------------------------------------------------------------

test('the tag vocabulary matches ALLOWED_TAGS in the backend', () => {
  const tagsPath = fileURLToPath(new URL('../../../backend/app/tags.py', import.meta.url))
  const source = readFileSync(tagsPath, 'utf8')

  const block = source.match(/^ALLOWED_TAGS = \(([\s\S]*?)^\)/m)
  assert.ok(block, 'could not find ALLOWED_TAGS in backend/app/tags.py')

  // Comments come out first. The block is commented, and a note explaining why
  // a tag exists naturally quotes its name — which the tag scan below would
  // otherwise read as a second entry and report as drift that isn't there.
  const entries = block[1].replace(/#[^\n]*/g, '')
  const backendTags = [...entries.matchAll(/"([^"]+)"/g)].map((m) => m[1])
  assert.ok(backendTags.length > 0, 'parsed no tags out of ALLOWED_TAGS')

  // Sets, not arrays: the backend groups them by kind in a different order to
  // TAG_GROUPS here, and that ordering is presentational on both sides.
  assert.deepEqual(
    [...backendTags].sort(),
    [...TAG_VOCABULARY].sort(),
    'frontend/src/lib/tags.js and backend/app/tags.py have drifted apart',
  )
})

test('the vocabulary has no duplicates', () => {
  assert.equal(new Set(TAG_VOCABULARY).size, TAG_VOCABULARY.length)
})

test('every vocabulary tag survives normalization unchanged', () => {
  // A tag that normalizes to something else could never be matched against what
  // the AI actually stores.
  for (const tag of TAG_VOCABULARY) {
    assert.equal(normalizeTag(tag), tag)
  }
})
