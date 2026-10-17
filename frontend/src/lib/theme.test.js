// The theme setting: what it accepts, what it keeps, and that a blocked storage
// does not break it. The colours are CSS tokens and are checked in a browser; this
// is only the value that selects them.

import test from 'node:test'
import assert from 'node:assert/strict'

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
}
globalThis.localStorage = new MemoryStorage()

const { THEME_MODES, setTheme } = await import('./theme.js')

test('the three modes are exactly auto, light and dark', () => {
  assert.deepEqual(THEME_MODES, ['auto', 'light', 'dark'])
})

test('a valid choice is kept on the device', () => {
  setTheme('dark')
  assert.equal(localStorage.getItem('recipebox:theme'), 'dark')
  setTheme('auto')
  assert.equal(localStorage.getItem('recipebox:theme'), 'auto')
})

test('anything else is ignored rather than stored', () => {
  setTheme('light')
  setTheme('sepia')
  setTheme(undefined)
  assert.equal(localStorage.getItem('recipebox:theme'), 'light')
})

test('storage that refuses writes does not throw', () => {
  const real = localStorage.setItem
  localStorage.setItem = () => {
    throw new Error('blocked')
  }
  assert.doesNotThrow(() => setTheme('dark'))
  localStorage.setItem = real
})
