import { useEffect, useMemo, useRef, useState } from 'react'
import { extractRecipe, structureText } from './lib/api.js'
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
  // Captured at mount, before the effect below strips the params off the URL.
  const [shareLink] = useState(() => readShare().url)
  const [fromShare] = useState(() => readShare().arrived)
  const autoImported = useRef(false)
  const [savedTitle, setSavedTitle] = useState('')
  const [importing, setImporting] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const inputRef = useRef(null)
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
  // capture path that actually works there. Safari gates readText() behind a
  // native Paste confirmation and rejects if it isn't tapped, so the fallback
  // focuses the field — iOS then offers Paste right above the keyboard.
  function pasteLink() {
    // Focus synchronously inside the tap. After an await the gesture window has
    // closed and iOS refuses to open the keyboard, taking its Paste bar with it.
    inputRef.current?.focus()
    navigator.clipboard
      .readText()
      .then((text) => {
        const match = text.match(/https?:\/\/\S+/)
        if (!match) {
          setError('No link on the clipboard. Copy the post link first.')
          return
        }
        setImportUrl(match[0])
        setError('')
        setShareNotice(false)
        inputRef.current?.blur()
      })
      .catch(() => {
        setError('Tap Paste above the keyboard, or press and hold the box and choose Paste.')
      })
  }

  async function importFromUrl(url) {
    if (!url || importing) return
    setImporting(true)
    setError('')
    setSavedTitle('')
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
      setSavedTitle(saved.title)
    } catch (err) {
      setError(err.message)
    } finally {
      setImporting(false)
    }
  }

  function handleImport(e) {
    e.preventDefault()
    importFromUrl(importUrl.trim())
  }

  // A share opens this tab for one job, so run the import without waiting for a
  // tap. Held until the recipe load finishes: that load calls setRecipes with
  // the stored list, which would drop anything saved ahead of it. The ref keeps
  // it to one run even though the effect re-fires as auth settles.
  useEffect(() => {
    if (!shareLink || autoImported.current) return
    if (!authReady || loading) return
    autoImported.current = true
    importFromUrl(shareLink)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareLink, authReady, loading])

  async function handlePasteText(e) {
    e.preventDefault()
    const text = pasteText.trim()
    if (text.length < 20 || importing) return
    setImporting(true)
    setError('')
    try {
      const recipe = await structureText(text)
      const saved = await store.save({
        ...recipe,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
      })
      setRecipes((prev) => [saved, ...prev])
      setPasteText('')
      setPasteOpen(false)
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
              ref={inputRef}
              type="url"
              placeholder="Paste a recipe URL (website, TikTok, Instagram)"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              onPaste={(e) => {
                // Share sheets copy the link with prose around it, which a
                // type="url" field would reject on submit.
                const text = e.clipboardData?.getData('text') || ''
                const match = text.match(/https?:\/\/\S+/)
                if (match && match[0] !== text.trim()) {
                  e.preventDefault()
                  setImportUrl(match[0])
                }
              }}
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
          {pasteOpen ? (
            <form className="rb-paste-text" onSubmit={handlePasteText}>
              <textarea
                rows={6}
                placeholder="Paste a recipe here — ingredients, steps, a caption, anything."
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                autoFocus
              />
              <div className="rb-paste-text-actions">
                <button type="button" onClick={() => setPasteOpen(false)}>
                  Cancel
                </button>
                <button type="submit" disabled={importing || pasteText.trim().length < 20}>
                  {importing ? 'Reading…' : 'Save recipe'}
                </button>
              </div>
            </form>
          ) : (
            <button type="button" className="rb-paste" onClick={() => setPasteOpen(true)}>
              Paste recipe text
            </button>
          )}
          {fromShare && importing && (
            <p className="rb-notice">Saving the shared link…</p>
          )}
          {savedTitle && (
            <p className="rb-saved">
              <span>
                Saved “{savedTitle}”.
                {fromShare && ' You can close this tab.'}
                {supabaseEnabled && !userId && ' Sign in to sync it to your other devices.'}
              </span>
              <button className="rb-notice-close" onClick={() => setSavedTitle('')}>
                Dismiss
              </button>
            </p>
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
                      {r.ingredients.length > 0
                        ? `${r.ingredients.length} ingredients`
                        : 'Saved link'}
                      {r.total_min ? ` · ${r.total_min} min` : ''}
                      {r.source_url ? ` · ${new URL(r.source_url).hostname.replace('www.', '')}` : ''}
                    </p>
                  </div>
                </button>
                {openId === r.id && (
                  <div className="recipes-detail">
                    {r.ingredients.length === 0 && r.instructions.length === 0 ? (
                      <>
                        {r.description && <p className="recipes-caption">{r.description}</p>}
                        <p className="recipes-meta">
                          No recipe was readable from this post. Open the source and paste the
                          text into Paste recipe text to fill it in.
                        </p>
                      </>
                    ) : (
                      <>
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
                      </>
                    )}
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
