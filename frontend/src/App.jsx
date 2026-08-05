import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { extractRecipe, structureText } from './lib/api.js'
import { supabase, supabaseEnabled } from './lib/supabase.js'
import { makeStore, migrateLocalRecipes } from './lib/store.js'
import { makePlanStore, migrateLocalPlan } from './lib/plan.js'
import { makeShoppingStore, migrateLocalShopping } from './lib/shopping.js'
import { addDays, startOfWeek, toISODate } from './lib/dates.js'
import { setBusy } from './lib/pwa.js'
import Account from './components/Account.jsx'
import Planner from './components/Planner.jsx'
import ShoppingList from './components/ShoppingList.jsx'

// PWA share target (Android) and the iOS Shortcuts workaround both land here:
// the post arrives as ?url=, or buried in ?text=/?title= prose.
const SHARE_PARAMS = ['url', 'text', 'title']

const canPaste = Boolean(navigator.clipboard?.readText)

// Pull-to-refresh gesture, in px of finger travel. PULL_RESIST damps the
// indicator so a 140px drag reads as 70px of pull — matches the native feel.
const PULL_THRESHOLD = 70
const PULL_MAX = 110
const PULL_RESIST = 0.5

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
  const [refreshing, setRefreshing] = useState(false)
  const [pull, setPull] = useState(0)
  // Mirrors of state the native touch listeners read: they bind once, so they
  // would otherwise see the values from first render forever.
  const pullRef = useRef(0)
  const refreshingRef = useRef(false)
  const importingRef = useRef(false)

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
  const planStore = useMemo(() => makePlanStore(userId), [userId])
  const shoppingStore = useMemo(() => makeShoppingStore(userId), [userId])

  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()))
  const [plan, setPlan] = useState([])
  // Checks and hand-added items. The list itself is derived from the plan.
  const [overlay, setOverlay] = useState([])

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

  // The plan is fetched a week at a time, so this re-runs on navigation as
  // well as on sign-in. Recipes migrate before plan rows do: meal_plan.recipe_id
  // is a foreign key, and migrateLocalRecipes keeps the local ids, so the
  // references still resolve after the move.
  const loadPlan = useCallback(async () => {
    const from = toISODate(weekStart)
    const to = toISODate(addDays(weekStart, 6))
    return planStore.listWeek(from, to)
  }, [planStore, weekStart])

  const loadOverlay = useCallback(
    async () => shoppingStore.listWeek(toISODate(weekStart)),
    [shoppingStore, weekStart],
  )

  useEffect(() => {
    if (!authReady) return
    let cancelled = false
    ;(async () => {
      try {
        if (userId) {
          await migrateLocalPlan(userId)
          await migrateLocalShopping(userId)
        }
        const [planRows, overlayRows] = await Promise.all([loadPlan(), loadOverlay()])
        if (!cancelled) {
          setPlan(planRows)
          setOverlay(overlayRows)
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [authReady, userId, loadPlan, loadOverlay])

  // Re-read the store without the auth/migrate work the mount effect does.
  // An installed PWA is resumed, not reloaded, so without this it shows the
  // list it fetched the first time it opened — a capture made in the browser
  // never appears. Skipped mid-import: that flow has already prepended the new
  // recipe optimistically, and a list fetched before the write landed would
  // wipe it back out.
  const refresh = useCallback(async () => {
    if (importingRef.current || refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    try {
      // Both, in parallel: the plan goes stale on resume for exactly the same
      // reason the recipe list does, and a plan row is meaningless without the
      // recipe it points at.
      const [list, rows, overlayRows] = await Promise.all([
        store.list(),
        loadPlan(),
        loadOverlay(),
      ])
      setRecipes(list)
      setPlan(rows)
      setOverlay(overlayRows)
      setError('')
    } catch (err) {
      setError(err.message)
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
  }, [store, loadPlan, loadOverlay])

  // Kept in a ref so the gesture and foreground listeners can bind once with
  // stable deps and still call the current closure.
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  useEffect(() => {
    importingRef.current = importing
  }, [importing])

  // Hold off service worker update checks during a capture. An update reloads
  // the page, which would discard whatever is in the paste box.
  useEffect(() => {
    setBusy(importing || pasteText.trim().length > 0)
  }, [importing, pasteText])

  // Foreground refetch. visibilitychange covers resuming a standalone PWA and
  // unlocking the phone; focus covers desktop tab switches, where a background
  // tab stays "visible". pageshow catches a bfcache restore, which fires
  // neither of the other two.
  useEffect(() => {
    if (!authReady) return
    function onVisible() {
      if (document.visibilityState === 'visible') refreshRef.current()
    }
    function onPageShow(e) {
      if (e.persisted) refreshRef.current()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [authReady])

  // Pull-to-refresh. Listeners are native rather than React's onTouchMove:
  // React registers touchmove as passive, so preventDefault there is ignored
  // and iOS rubber-bands the page instead of showing the pull.
  useEffect(() => {
    let startY = null
    let pulling = false

    function reset() {
      pulling = false
      startY = null
      pullRef.current = 0
      setPull(0)
    }

    function onStart(e) {
      if (e.touches.length !== 1 || window.scrollY > 0) return
      startY = e.touches[0].clientY
      pulling = true
    }

    function onMove(e) {
      if (!pulling || startY === null) return
      const delta = e.touches[0].clientY - startY
      // Upward drag, or the page scrolled under us: hand the touch back so it
      // behaves as an ordinary scroll.
      if (delta <= 0 || window.scrollY > 0) {
        reset()
        return
      }
      e.preventDefault()
      const distance = Math.min(PULL_MAX, delta * PULL_RESIST)
      pullRef.current = distance
      setPull(distance)
    }

    function onEnd() {
      if (!pulling) return
      const distance = pullRef.current
      reset()
      if (distance >= PULL_THRESHOLD) refreshRef.current()
    }

    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd)
    document.addEventListener('touchcancel', reset)
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', reset)
    }
  }, [])

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
      // Postgres cascades this via the foreign key; the local backend has no
      // such thing, so it is done by hand there. Either way the rows are gone,
      // so drop them from view without a refetch.
      await planStore.removeByRecipe(id)
      setPlan((prev) => prev.filter((e) => e.recipe_id !== id))
      if (openId === id) setOpenId(null)
    } catch (err) {
      setError(err.message)
    }
  }

  function changeWeek(direction) {
    // 0 means "back to today", which is its own case rather than an offset.
    setWeekStart((prev) => (direction === 0 ? startOfWeek(new Date()) : addDays(prev, direction * 7)))
  }

  async function handleAssign(recipeId, dateISO, slot) {
    const entry = {
      id: crypto.randomUUID(),
      recipe_id: recipeId,
      plan_date: dateISO,
      slot,
      created_at: new Date().toISOString(),
    }
    // Optimistic: the sheet closes on tap, so waiting on the round trip would
    // show an empty day for as long as the write takes.
    setPlan((prev) => [...prev, entry])
    try {
      const saved = await planStore.add(entry)
      setPlan((prev) => prev.map((e) => (e.id === entry.id ? saved : e)))
    } catch (err) {
      setPlan((prev) => prev.filter((e) => e.id !== entry.id))
      setError(err.message)
    }
  }

  // Ticking a derived line writes a check row the first time and updates it
  // afterwards. There is no unique constraint to upsert against, and adding one
  // for a partial index is more trouble through PostgREST than just looking.
  async function handleToggleDerived(key, checked) {
    const existing = overlay.find((row) => row.kind === 'check' && row.name === key)
    const before = overlay
    if (existing) {
      setOverlay((prev) => prev.map((r) => (r.id === existing.id ? { ...r, checked } : r)))
      try {
        await shoppingStore.update(existing.id, { checked })
      } catch (err) {
        setOverlay(before)
        setError(err.message)
      }
      return
    }
    const row = {
      id: crypto.randomUUID(),
      week_start: toISODate(weekStart),
      name: key,
      kind: 'check',
      checked,
      created_at: new Date().toISOString(),
    }
    setOverlay((prev) => [...prev, row])
    try {
      const saved = await shoppingStore.add(row)
      setOverlay((prev) => prev.map((r) => (r.id === row.id ? saved : r)))
    } catch (err) {
      setOverlay(before)
      setError(err.message)
    }
  }

  async function handleToggleManual(id, checked) {
    const before = overlay
    setOverlay((prev) => prev.map((r) => (r.id === id ? { ...r, checked } : r)))
    try {
      await shoppingStore.update(id, { checked })
    } catch (err) {
      setOverlay(before)
      setError(err.message)
    }
  }

  async function handleAddManual(name) {
    const row = {
      id: crypto.randomUUID(),
      week_start: toISODate(weekStart),
      name,
      kind: 'manual',
      checked: false,
      created_at: new Date().toISOString(),
    }
    setOverlay((prev) => [...prev, row])
    try {
      const saved = await shoppingStore.add(row)
      setOverlay((prev) => prev.map((r) => (r.id === row.id ? saved : r)))
    } catch (err) {
      setOverlay((prev) => prev.filter((r) => r.id !== row.id))
      setError(err.message)
    }
  }

  async function handleRemoveManual(id) {
    const before = overlay
    setOverlay((prev) => prev.filter((r) => r.id !== id))
    try {
      await shoppingStore.remove(id)
    } catch (err) {
      setOverlay(before)
      setError(err.message)
    }
  }

  async function handleUnassign(id) {
    const removed = plan.find((e) => e.id === id)
    setPlan((prev) => prev.filter((e) => e.id !== id))
    try {
      await planStore.remove(id)
    } catch (err) {
      if (removed) setPlan((prev) => [...prev, removed])
      setError(err.message)
    }
  }

  const pullActive = pull > 0 || refreshing

  return (
    <div className="rb-app">
      <div
        className={pullActive ? 'rb-pull rb-pull-active' : 'rb-pull'}
        style={{ transform: `translateY(${refreshing ? PULL_THRESHOLD : pull}px)` }}
        aria-hidden={!pullActive}
      >
        <span className={refreshing ? 'rb-pull-spinner rb-pull-spinning' : 'rb-pull-spinner'} />
        <span className="rb-pull-label">
          {refreshing
            ? 'Refreshing…'
            : pull >= PULL_THRESHOLD
              ? 'Release to refresh'
              : 'Pull to refresh'}
        </span>
      </div>
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

      {tab === 'planner' && (
        <main className="rb-main">
          <Planner
            weekStart={weekStart}
            plan={plan}
            recipes={recipes}
            loading={loading}
            onWeekChange={changeWeek}
            onAssign={handleAssign}
            onUnassign={handleUnassign}
          />
          {error && <p className="rb-error">{error}</p>}
        </main>
      )}

      {tab === 'shopping' && (
        <main className="rb-main">
          <ShoppingList
            weekStart={weekStart}
            plan={plan}
            recipes={recipes}
            overlay={overlay}
            onWeekChange={changeWeek}
            onToggleDerived={handleToggleDerived}
            onToggleManual={handleToggleManual}
            onAddManual={handleAddManual}
            onRemoveManual={handleRemoveManual}
          />
          {error && <p className="rb-error">{error}</p>}
        </main>
      )}
    </div>
  )
}
