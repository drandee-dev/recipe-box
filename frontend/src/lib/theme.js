// Light, dark, or follow the device. One value for the whole app, kept on this
// device like the units setting. The colours themselves are tokens in index.css:
// `auto` leaves the page to the browser's prefers-color-scheme, and `light` or
// `dark` set data-theme on <html>, which the stylesheet reads in place of it.
//
// index.html applies a saved light/dark before the first paint, so a dark phone
// does not flash a light page while the bundle loads. This module applies it
// again on import (the same answer) and keeps the browser's theme-color in step.

import { useSyncExternalStore } from 'react'

export const THEME_MODES = ['auto', 'light', 'dark']

const KEY = 'recipebox:theme'
const listeners = new Set()

function read() {
  try {
    const saved = localStorage.getItem(KEY)
    return THEME_MODES.includes(saved) ? saved : 'auto'
  } catch {
    // Storage blocked: follow the device, which is always a sane answer.
    return 'auto'
  }
}

let current = read()

const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null

// The colour the browser paints its own bar with. Light keeps the brand green the
// manifest already uses; dark takes the page ground so the bar does not glare.
const BAR = { light: '#1c7c54', dark: '#151813' }

function apply() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (current === 'auto') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', current)
  const dark = current === 'dark' || (current === 'auto' && Boolean(media?.matches))
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? BAR.dark : BAR.light)
}

export function setTheme(mode) {
  if (!THEME_MODES.includes(mode) || mode === current) return
  current = mode
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    // The choice holds for this session even if it cannot be saved.
  }
  apply()
  listeners.forEach((listener) => listener())
}

// While following the device, the bar colour has to follow it live.
media?.addEventListener?.('change', () => {
  if (current === 'auto') apply()
})

apply()

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTheme() {
  return useSyncExternalStore(subscribe, () => current, () => 'auto')
}
