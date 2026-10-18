// Step sections in the store: the column is written only when the recipe carries
// it, a list that does not line up with the steps is never written, and the
// client and the schema agree that the column exists.
//
// The agreement is checked by text because it is the one thing no other test can
// see: the client selects `instruction_groups` by name, so a build that ships
// before the column exists breaks every read of the recipes table, and a column
// the client never selects is silently never read.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

class MemoryStorage {
  #data = new Map()
  getItem(k) {
    return this.#data.has(k) ? this.#data.get(k) : null
  }
  setItem(k, v) {
    this.#data.set(k, String(v))
  }
  removeItem(k) {
    this.#data.delete(k)
  }
  clear() {
    this.#data.clear()
  }
}
globalThis.localStorage = new MemoryStorage()

const { toRow, stepSections } = await import('./store.js')

const base = { id: 'x', title: 'T', instructions: ['a', 'b', 'c'] }

test('a write that does not know about step sections leaves the column out', () => {
  assert.equal('instruction_groups' in toRow(base), false)
})

test('null clears, and a list that lines up with the steps is written', () => {
  assert.equal(toRow({ ...base, instruction_groups: null }).instruction_groups, null)
  assert.deepEqual(toRow({ ...base, instruction_groups: [null, 'Crust', 'Crust'] }).instruction_groups, [
    null,
    'Crust',
    'Crust',
  ])
})

test('a list of the wrong length, or of the wrong kind, is stored as null', () => {
  assert.equal(stepSections(['Crust', 'Crust'], ['a', 'b', 'c']), null)
  assert.equal(stepSections(['Crust', 5, null], ['a', 'b', 'c']), null)
  assert.equal(stepSections('Crust', ['a']), null)
  assert.equal(stepSections([null, null, null], ['a', 'b', 'c']), null)
  assert.equal(stepSections(['A'], undefined), null)
})

test('the client selects the column and the schema creates it', () => {
  const store = readFileSync(new URL('./store.js', import.meta.url), 'utf8')
  const schema = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8')
  assert.match(store, /'notes,instruction_groups,created_at,updated_at'/)
  assert.match(schema, /alter table recipes add column if not exists instruction_groups jsonb;/)
})
