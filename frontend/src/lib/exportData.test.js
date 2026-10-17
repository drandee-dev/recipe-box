// The export file: what goes in, what is left out, and the name it gets.

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildExport, exportFilename } from './exportData.js'
import { APP_VERSION } from './news.js'

const recipe = {
  id: 'r1',
  user_id: 'secret-account-id',
  title: 'Soup',
  ingredients: [{ raw: '1 cup stock', item: null, qty: null, unit: null }],
  instructions: ['Heat.'],
  tags: ['soup'],
  image_url: 'https://example.test/a.jpg',
  image_blur: 'data:image/jpeg;base64,AAAA',
  favorite: true,
}

test('every recipe is in the file, whole, apart from account ids and the blur placeholder', () => {
  const out = buildExport([recipe, { ...recipe, id: 'r2' }], new Date('2026-10-17T12:00:00Z'))
  assert.equal(out.count, 2)
  assert.equal(out.recipes.length, 2)
  assert.equal(out.app, 'recipe-box')
  assert.equal(out.app_version, APP_VERSION)
  assert.equal(out.exported_at, '2026-10-17T12:00:00.000Z')
  const [first] = out.recipes
  assert.equal('user_id' in first, false)
  assert.equal('image_blur' in first, false)
  assert.deepEqual(first.ingredients, recipe.ingredients)
  assert.deepEqual(first.instructions, recipe.instructions)
  assert.equal(first.favorite, true)
  assert.equal(first.image_url, recipe.image_url)
})

test('an empty box exports an empty, valid file', () => {
  const out = buildExport([])
  assert.equal(out.count, 0)
  assert.deepEqual(out.recipes, [])
  JSON.parse(JSON.stringify(out))
})

test('the file name carries the local date, zero padded', () => {
  assert.equal(exportFilename(new Date(2026, 0, 5)), 'recipe-box-2026-01-05.json')
})

test('the input is not mutated', () => {
  const copy = JSON.parse(JSON.stringify(recipe))
  buildExport([recipe])
  assert.deepEqual(recipe, copy)
})
