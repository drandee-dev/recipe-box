const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8002'

async function post(path, body) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
