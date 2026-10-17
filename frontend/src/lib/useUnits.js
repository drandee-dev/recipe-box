// The person's unit preference: show recipes and the shopping list as written
// (the default), in metric, or in US measures. One value for the whole app, kept
// on this device. It never changes a saved recipe: it only changes what is shown
// (lib/convert.js), so switching it back always returns what the recipe said.

import { useSyncExternalStore } from 'react'
import { UNIT_MODES } from './convert.js'

const KEY = 'recipebox:units'
const listeners = new Set()

function read() {
  try {
    const saved = localStorage.getItem(KEY)
    return UNIT_MODES.includes(saved) ? saved : 'original'
  } catch {
    // Storage blocked: as written, which is always correct.
    return 'original'
  }
}

let current = read()

export function setUnits(mode) {
  if (!UNIT_MODES.includes(mode) || mode === current) return
  current = mode
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    // The choice holds for this session even if it cannot be saved.
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useUnits() {
  return useSyncExternalStore(subscribe, () => current, () => 'original')
}
