import { useEffect, useMemo, useState } from 'react'
import { extractRecipe } from './lib/api.js'
import { supabase, supabaseEnabled } from './lib/supabase.js'
import { makeStore, migrateLocalRecipes } from './lib/store.js'
import Account from './components/Account.jsx'

// PWA share target (Android) and the iOS Shortcuts workaround both land here:
// the post arrives as ?url=, or buried in ?text=/?title= prose.
const SHARE_PARAMS = ['url', 'text', 'title']

const canPaste = Boolean(navigator.clipboard?.readText)

function readShare() {
  const params = new URLSearchParams(window.location.search)
  const arrived = SHARE_PARAMS.some((p) => params.has(p))
  const direct = (params.get('url') || '').trim()
  if (direct) return { url: direct, arrived }
  const prose = `${params.get('text') || ''} ${params.get('title') || ''}`
  const match = prose.match(/https?:\/\/\S+/)
  return { url: match ? match[0] : '', arrived }
}

export default function App() {
  const [tab, setTab] = useState('recipes')
  const [recipes, setRecipes] = useState([])
  const [loading, setLoading] = useState(true)
  const [importUrl, setImportUrl] = useState(() => readShare().url)
  const [shareNotice, setShareNotice] = useState(() => {
    const share = readShare()
    return share.arrived && !share.url
  })
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState(null)

  // Consume the share params so a refresh doesn't re-fill the bar. Only the
  // share keys are removed; Supabase's auth callback params must survive.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (!SHARE_PARAMS.some((p) => params.has(p))) return
    SHARE_PARAMS.forEach((p) => params.delete(p))
    const qs = params.toString()
    window.history.replaceState({}, '', qs ? `?${qs}` : window.location.pathname)
  }, [])

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

  // iOS drops share-target params when it launches the installed home-screen
  // app, so "Copy link" in the IG/TikTok share sheet plus this button is the
  // capture path that actually works there.
  async function pasteLink() {
    try {
      const text = await navigator.clipboard.readText()
      const match = text.match(/https?:\/\/\S+/)
      if (!match) {
        setError('No link on the clipboard. Copy the post link first.')
        return
      }
      setImportUrl(match[0])
      setError('')
      setShareNotice(false)
    } catch {
      setError('Could not read the clipboard. Paste into the box instead.')
    }
  }

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
          {canPaste && (
            <button type="button" className="rb-paste" onClick={pasteLink}>
              Paste copied link
            </button>
          )}
          {shareNotice && (
            <p className="rb-notice">
              A share arrived without a link in it. Copy the post link and paste it above.
              <button className="rb-notice-close" onClick={() => setShareNotice(false)}>
                Dismiss
              </button>
            </p>
          )}
          {error && <p className="rb-error">{error}</p>}

          {recipes.length === 0 && !importing && !loading && (
            <p className="rb-empty">
              No recipes yet. Paste a recipe link above, or copy a post link in Instagram or
              TikTok and tap Paste copied link.
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
