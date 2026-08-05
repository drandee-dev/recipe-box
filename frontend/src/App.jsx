import { useEffect, useMemo, useState } from 'react'
import { extractRecipe } from './lib/api.js'
import { supabase, supabaseEnabled } from './lib/supabase.js'
import { makeStore, migrateLocalRecipes } from './lib/store.js'
import Account from './components/Account.jsx'

// PWA share target: shared TikTok/IG posts arrive as ?url= or buried in ?text=
function sharedUrl() {
  const params = new URLSearchParams(window.location.search)
  const direct = params.get('url')
  if (direct) return direct
  const text = params.get('text') || ''
  const match = text.match(/https?:\/\/\S+/)
  return match ? match[0] : ''
}

export default function App() {
  const [tab, setTab] = useState('recipes')
  const [recipes, setRecipes] = useState([])
  const [loading, setLoading] = useState(true)
  const [importUrl, setImportUrl] = useState(sharedUrl)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState(null)

  // Auth session. authReady gates the recipe load so a restoring cloud session
  // isn't raced by a local-storage read (mtg-web pattern).
  const [session, setSession] = useState(null)
  const [authReady, setAuthReady] = useState(!supabaseEnabled)

  useEffect(() => {
    if (!supabaseEnabled) return
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setAuthReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      setAuthReady(true)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  // Refresh session when the tab becomes visible (phone sleep/background)
  useEffect(() => {
    if (!supabaseEnabled) return
    function onVisible() {
      if (document.visibilityState === 'visible') {
        supabase.auth.getSession().then(({ data }) => setSession(data.session))
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  const userId = session?.user?.id || null
  const store = useMemo(() => makeStore(userId), [userId])

  // Load recipes once auth settles. On sign-in, local captures upload first —
  // one-time, since the local key is cleared after a successful upload.
  useEffect(() => {
    if (!authReady) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        if (userId) await migrateLocalRecipes(userId)
        const list = await store.list()
        if (!cancelled) {
          setRecipes(list)
          setError('')
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [authReady, userId, store])

  async function handleImport(e) {
    e.preventDefault()
    const url = importUrl.trim()
    if (!url || importing) return
    setImporting(true)
    setError('')
    try {
      const recipe = await extractRecipe(url)
      const saved = await store.save({
        ...recipe,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
      })
      setRecipes((prev) => [saved, ...prev])
      setImportUrl('')
      setOpenId(saved.id)
    } catch (err) {
      setError(err.message)
    } finally {
      setImporting(false)
    }
  }

  async function handleDelete(id) {
    try {
      await store.remove(id)
      setRecipes((prev) => prev.filter((r) => r.id !== id))
      if (openId === id) setOpenId(null)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="rb-app">
      <header className="rb-header">
        <div className="rb-header-row">
          <h1>Recipe Box</h1>
          <Account session={session} />
        </div>
        <nav className="rb-tabs">
          {['recipes', 'planner', 'shopping'].map((t) => (
            <button
              key={t}
              className={tab === t ? 'rb-tab rb-tab-active' : 'rb-tab'}
              onClick={() => setTab(t)}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
      </header>

      {tab === 'recipes' && (
        <main className="rb-main">
          <form className="rb-import" onSubmit={handleImport}>
            <input
              type="url"
              placeholder="Paste a recipe URL (website, TikTok, Instagram)"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
            />
            <button type="submit" disabled={importing}>
              {importing ? 'Importing…' : 'Import'}
            </button>
          </form>
          {error && <p className="rb-error">{error}</p>}

          {recipes.length === 0 && !importing && !loading && (
            <p className="rb-empty">
              No recipes yet. Paste a link above — most recipe sites import automatically.
            </p>
          )}

          <ul className="recipes-list">
            {recipes.map((r) => (
              <li key={r.id} className="recipes-card">
                <button className="recipes-card-head" onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                  {r.image_url && <img src={r.image_url} alt="" loading="lazy" />}
                  <div>
                    <h2>{r.title}</h2>
                    <p className="recipes-meta">
                      {r.ingredients.length} ingredients
                      {r.total_min ? ` · ${r.total_min} min` : ''}
                      {r.source_url ? ` · ${new URL(r.source_url).hostname.replace('www.', '')}` : ''}
                    </p>
                  </div>
                </button>
                {openId === r.id && (
                  <div className="recipes-detail">
                    <h3>Ingredients</h3>
                    <ul>
                      {r.ingredients.map((ing, i) => (
                        <li key={i}>{ing.raw}</li>
                      ))}
                    </ul>
                    <h3>Steps</h3>
                    <ol>
                      {r.instructions.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ol>
                    <div className="recipes-actions">
                      {r.source_url && (
                        <a href={r.source_url} target="_blank" rel="noreferrer">
                          View source
                        </a>
                      )}
                      <button className="rb-danger" onClick={() => handleDelete(r.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </main>
      )}

      {tab !== 'recipes' && (
        <main className="rb-main">
          <p className="rb-empty">
            {tab === 'planner' ? 'Weekly meal planner' : 'Shopping list'} lands in phase 4.
          </p>
        </main>
      )}
    </div>
  )
}
