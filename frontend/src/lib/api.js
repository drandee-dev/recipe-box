const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8002'

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' }
  // Only the image endpoint sends one. It writes to our storage bucket and keeps
  // what it fetches, so it wants to know whose folder the objects go in.
  if (token) headers.Authorization = `Bearer ${token}`
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const detail = await resp.json().catch(() => ({}))
    throw new Error(detail.detail || 'Request failed')
  }
  return resp.json()
}

export function extractRecipe(url) {
  return post('/api/recipes/extract', { url })
}

// Paste-anything box: raw text through the same Haiku structurer.
export function structureText(text) {
  return post('/api/recipes/structure', { text })
}

// Phase 7. Hands the origin's image URL to the backend, which fetches it while
// it still works, resizes it and stores it under our own account. Returns
// { image_url, image_thumb_url, image_blur }.
export function mirrorRecipeImage(recipeId, url, token) {
  return post('/api/recipes/image', { recipe_id: recipeId, url }, token)
}
