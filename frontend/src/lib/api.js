const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8002'

export async function extractRecipe(url) {
  const resp = await fetch(`${API_BASE}/api/recipes/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    throw new Error(body.detail || 'Import failed')
  }
  return resp.json()
}
