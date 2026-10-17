// "Download all my recipes" (Phase D). Losing recipes is the complaint that
// recurs across the competitor reviews, and until now the only copy of a
// signed-out person's recipes was one browser's localStorage.
//
// The file is plain JSON with a small envelope, so it can be read by hand and
// by a future importer. Photos are linked by URL, not embedded: our own bucket
// URLs keep working while the account exists, and embedding would turn a few
// kilobytes of text into a multi-megabyte download.

import { APP_VERSION } from './news.js'

// Columns that mean nothing outside this database. `image_blur` is a ~20px
// inline placeholder and `user_id` is an account identifier the person has no
// reason to carry around in a file they might share.
const OMIT = new Set(['user_id', 'image_blur'])

export function buildExport(recipes, now = new Date()) {
  return {
    app: 'recipe-box',
    format: 1,
    app_version: APP_VERSION,
    exported_at: now.toISOString(),
    count: recipes.length,
    recipes: recipes.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !OMIT.has(k)))),
  }
}

export function exportFilename(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `recipe-box-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`
}

// Browser only. A Blob and a temporary link is the one route that works in
// every current browser, including iOS Safari.
export function downloadExport(recipes, now = new Date()) {
  const body = JSON.stringify(buildExport(recipes, now), null, 2)
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = exportFilename(now)
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked on the next turn: some browsers read the URL asynchronously after
  // click(), and revoking inside the same tick cancels the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
