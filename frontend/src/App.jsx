import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { extractRecipe, mirrorRecipeImage, structureImage, structureText, uploadRecipeImage } from './lib/api.js'
import { PhotoError, readPhoto } from './lib/photo.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'
import { makeStore, migrateLocalRecipes } from './lib/store.js'
import { makePlanStore, migrateLocalPlan } from './lib/plan.js'
import { KEEP_WEEKS, makeShoppingStore, migrateLocalShopping } from './lib/shopping.js'
import { makePrefsStore, migrateLocalPrefs } from './lib/prefs.js'
import { makeCookStore, migrateLocalCookLog } from './lib/cooklog.js'
import { cookStats as statsOf } from './lib/cooked.js'
import { cacheKeys, seedRecipes, updateMirror, withMirror } from './lib/cache.js'
import { MIRROR_CONCURRENCY, mirrorSource, needsGlyphRepair, needsMirror } from './lib/images.js'
import { addDays, fromISODate, startOfWeek, toISODate, weekRangeLabel } from './lib/dates.js'
import { setBusy } from './lib/pwa.js'
import { useSession } from './lib/useSession.js'
import { PULL_MIN_SPIN, PULL_TRIGGER, usePullToRefresh } from './lib/usePullToRefresh.js'
import Account from './components/Account.jsx'
import CaptureSheet from './components/CaptureSheet.jsx'
import InstallPrompt from './components/InstallPrompt.jsx'
import { FeedbackSheet, NewsBanner, WhatsNewSheet } from './components/News.jsx'
import { TimerTray, TimersButton, TimersSheet } from './components/Timers.jsx'
import { OPEN_RECIPE_EVENT, useTimers } from './lib/useTimers.jsx'
import { latestNews, markNewsSeen, newsSeen } from './lib/news.js'
import Planner from './components/Planner.jsx'
import RecipeEditor from './components/RecipeEditor.jsx'
import RecipeList from './components/RecipeList.jsx'
import ShoppingList from './components/ShoppingList.jsx'
import TabBar from './components/TabBar.jsx'

// PWA share target (Android) and the iOS Shortcuts workaround both land here:
// the post arrives as ?url=, or buried in ?text=/?title= prose.
const SHARE_PARAMS = ['url', 'text', 'title']

const canPaste = Boolean(navigator.clipboard?.readText)

// Postgres speaks to the client through PostgREST, so a constraint rejection
// arrives as its own SQL wording — `insert or update on table "meal_plan"
// violates foreign key constraint …`. That is a sentence about our schema, not
// about anything the reader did or can act on.
const DB_JARGON = /violates .* constraint|duplicate key|relation ".*" does not exist/i

function humanMessage(err, fallback) {
  const message = err?.message || ''
  if (DB_JARGON.test(message)) return fallback
  return message || fallback
}

// A write that fails with no network surfaces the fetch layer's own wording
// ("Failed to fetch", "Load failed" on Safari), which explains nothing. Real
// errors pass through untouched.
function writeError(err) {
  if (!navigator.onLine) return "You're offline. That change didn't save."
  return humanMessage(err, "That change didn't save. Try again.")
}

// Only reached when the offline mirror had nothing to fall back on, which for a
// signed-in account means this device has never loaded the list.
function readError(err) {
  if (!navigator.onLine) return "You're offline, and nothing is saved on this device yet."
  return humanMessage(err, 'That could not be loaded. Pull down to try again.')
}

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
  // Seeded from the offline mirror rather than starting empty (audit item 14).
  // The rows for the last signed-in user are already in localStorage, and this
  // is a change to *when* they are read, not to what they guarantee: the cloud
  // read below still runs and still replaces them. What it buys is a first paint
  // with real recipes and real image URLs, which is also what finally lets the
  // `fetchpriority` and eager loading in RecipeThumb do the job they were
  // written for — before this, the LCP image's URL wasn't knowable until three
  // round trips had completed.
  const [recipes, setRecipes] = useState(seedRecipes)
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
  // Saved, but the source only had ingredients. Not an error, so it rides the
  // saved banner rather than setError.
  const [savedPartial, setSavedPartial] = useState(false)
  const [importing, setImporting] = useState(false)
  const [captureOpen, setCaptureOpen] = useState(false)
  // The newest news entry, hidden once closed (lib/news.js remembers its id).
  // newsSheet is which of its two sheets is up: 'whatsnew', 'feedback' or null.
  const [news] = useState(latestNews)
  const [newsClosed, setNewsClosed] = useState(() => !news || newsSeen(news.id))
  const [newsSheet, setNewsSheet] = useState(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  // `{ base64, preview, width, height }` from lib/photo.js, or null. Held here
  // rather than in CaptureSheet because the preview is an object URL that has to
  // be revoked, and the component unmounts every time the sheet closes.
  const [photo, setPhoto] = useState(null)
  const inputRef = useRef(null)
  const [error, setError] = useState('')
  // A timer alert's notification opens the app at `/?recipe=<id>` (the push
  // payload's navigate URL, server side in app/push.py). The id is only compared
  // to recipe ids, so nothing in it is trusted as anything else. If the list
  // hasn't loaded yet the recipe opens when it arrives.
  const [openId, setOpenId] = useState(() => new URLSearchParams(window.location.search).get('recipe'))
  // null when closed, { recipe } when open — with recipe null for a new one.
  // An object rather than two booleans so "editing this recipe" can't drift out
  // of step with "the editor is open".
  const [editing, setEditing] = useState(null)
  // Search and filters are view state only — never persisted. A saved filter
  // that outlives the session is a recipe list that looks empty for no reason.
  const [query, setQuery] = useState('')
  const [activeTags, setActiveTags] = useState([])
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  // True when what's on screen came out of the offline mirror rather than the
  // cloud. One flag for all three lists: they share a network, so in practice
  // they fall back and recover together.
  const [offline, setOffline] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  // Mirrors of state the refresh callback reads from inside a closure that
  // binds once.
  const refreshingRef = useRef(false)
  const importingRef = useRef(false)

  // Consume the share params so a refresh doesn't re-fill the bar. Only the
  // share keys are removed; Supabase's auth callback params must survive.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (!SHARE_PARAMS.some((p) => params.has(p)) && !params.has('recipe')) return
    SHARE_PARAMS.forEach((p) => params.delete(p))
    params.delete('recipe')
    const qs = params.toString()
    // The hash has to be carried through. A magic-link callback puts its tokens
    // there, and since audit item 15 the Supabase client is built inside the
    // auth effect below rather than at module load — so this strip now runs
    // *first*, and dropping the hash here would take the tokens with it before
    // anything had a chance to read them.
    const hash = window.location.hash
    window.history.replaceState({}, '', `${qs ? `?${qs}` : window.location.pathname}${hash}`)
  }, [])

  // Who is signed in, and whether we know yet. `authReady` gates the recipe
  // load below so a restoring cloud session isn't raced by a localStorage read.
  // The hook is also where the Supabase client gets built, which is what keeps
  // it out of the entry chunk — see the note in useSession.js.
  const { session, userId, ready: authReady } = useSession()

  // The timers provider sits above this component, so it is told who is signed
  // in rather than asking: alerts are only mirrored for a signed-in user.
  const { setSignedIn } = useTimers()
  useEffect(() => {
    setSignedIn(Boolean(userId))
  }, [userId, setSignedIn])

  const store = useMemo(() => makeStore(userId), [userId])
  const planStore = useMemo(() => makePlanStore(userId), [userId])
  const shoppingStore = useMemo(() => makeShoppingStore(userId), [userId])
  const prefsStore = useMemo(() => makePrefsStore(userId), [userId])
  const cookStore = useMemo(() => makeCookStore(userId), [userId])

  // Recipes this session has already handed to the mirror, successfully or not.
  // Success needs it because the list re-renders and reloads constantly and the
  // row won't say it's ours until the write lands. Failure needs it more: an
  // Instagram URL that expired months ago fails the same way every time, and
  // without this every resume would spend a serverless invocation rediscovering
  // that. A reload clears it, which is the retry.
  const mirrored = useRef(new Set())
  // {id, created_at} of a recipe the editor created but whose photo upload failed;
  // see handleEditorSave. Cleared when the editor closes.
  const newDraft = useRef(null)

  // Phase 7. Fetch the photo while its URL still works and store it under our
  // own account, so it stops mattering that the origin will take it away.
  //
  // Deliberately in the background rather than inside the import: it adds a
  // download, a resize and two uploads, and making the capture flow wait on all
  // of that to show a recipe that already has its photo would be paying at the
  // one moment the app is being watched. The same function does the backfill,
  // since a recipe saved last week and one saved ten seconds ago are the same
  // problem.
  const mirrorImages = useCallback(
    async (list) => {
      // No account means no bucket to write to, and offline means the attempt
      // burns a slot in `mirrored` on a failure that says nothing about the URL.
      if (!userId || !supabaseEnabled || !navigator.onLine) return
      // Two jobs, one loop, because they are the same call: a first mirror hands
      // the backend the origin's URL, a repair hands it our own copy, and either
      // way what comes back is the three image columns. Instagram recipes
      // mirrored before the play-glyph strip existed have a play button in the
      // middle of the photo we are holding — see needsGlyphRepair.
      const pending = list.filter(
        (r) => (needsMirror(r) || needsGlyphRepair(r)) && !mirrored.current.has(r.id),
      )
      // Checked before the client is asked for, so a list with nothing to mirror
      // never touches the deferred import.
      if (pending.length === 0) return

      const supabase = await getSupabase()
      const { data } = await supabase.auth.getSession()
      const token = data?.session?.access_token
      if (!token) return

      // Claimed after the await, not before it: getSession can yield long enough
      // for a resume refetch to arrive with the same recipes in it.
      const queue = pending.filter((r) => !mirrored.current.has(r.id))
      queue.forEach((r) => mirrored.current.add(r.id))

      // A small pool rather than Promise.all: each item is a full download,
      // resize and two uploads on the backend, and a box of forty recipes on
      // first sign-in should not open forty serverless invocations at once.
      async function worker() {
        while (queue.length > 0) {
          const recipe = queue.shift()
          try {
            const columns = await mirrorRecipeImage(recipe.id, mirrorSource(recipe), token)
            const saved = await store.saveImage(recipe.id, columns)
            if (saved) setRecipes((prev) => prev.map((r) => (r.id === saved.id ? saved : r)))
          } catch {
            // Silent on purpose. The recipe keeps the origin's URL, which is
            // exactly what it had before phase 7, and RecipeThumb already
            // handles that URL dying. Telling someone their photo didn't get
            // backed up asks them to do something about it, and there is
            // nothing they can do.
          }
        }
      }

      await Promise.all(Array.from({ length: MIRROR_CONCURRENCY }, () => worker()))
    },
    [userId, store],
  )

  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()))
  const [plan, setPlan] = useState([])
  // Every time a recipe was cooked (cook_log), whole: it is one small row per
  // cook, and the count, last date and sorts all derive from it.
  const [cookLog, setCookLog] = useState([])
  const cookStats = useMemo(() => statsOf(cookLog), [cookLog])
  // Checks and hand-added items. The list itself is derived from the plan.
  const [overlay, setOverlay] = useState([])

  // Staples, moved aisles and aisle order (lib/prefs.js). Null until they have
  // loaded, and the list offers no way to change them while null: saving is an
  // upsert of the whole object, so editing a copy that failed to load would
  // overwrite the real one with nearly nothing.
  const [prefs, setPrefs] = useState(null)
  const prefsQueue = useRef(Promise.resolve())

  useEffect(() => {
    if (!authReady) return
    let cancelled = false
    setPrefs(null)
    ;(async () => {
      try {
        if (userId) await migrateLocalPrefs(userId)
        const loaded = await prefsStore.load()
        if (!cancelled) setPrefs(loaded)
      } catch {
        // Display-only, so a failed read costs the staples and aisle choices
        // for this visit, not the list. The controls stay off (prefs stays null).
      }
    })()
    return () => {
      cancelled = true
    }
  }, [authReady, userId, prefsStore])

  // Saves go one after another: two quick taps are two upserts of the whole
  // object, and the later one must land last or the earlier tap wins.
  function handleChangePrefs(next) {
    setPrefs(next)
    prefsQueue.current = prefsQueue.current
      .then(() => prefsStore.save(next))
      .catch(async (err) => {
        setError(writeError(err))
        try {
          setPrefs(await prefsStore.load())
        } catch {
          setPrefs(null)
        }
      })
  }

  // Shopping rows for weeks long gone (AUDIT 10), once per visit. Ticks and
  // hand-added items are only read for the week on screen. Quiet on failure:
  // housekeeping is not worth an error banner.
  useEffect(() => {
    if (!authReady || !navigator.onLine) return
    const cutoff = toISODate(addDays(startOfWeek(new Date()), -7 * KEEP_WEEKS))
    shoppingStore.prune(cutoff).catch(() => {})
  }, [authReady, shoppingStore])

  // The recipe migration, published for the plan effect to wait on. Both load
  // effects fire in the same tick, so the ordering the foreign key needs cannot
  // come from which effect is written first — meal_plan.recipe_id references
  // recipes, and a plan upsert that reaches Postgres before the recipes it
  // points at is rejected outright.
  const recipesMigratedRef = useRef(null)

  // Load recipes once auth settles. On sign-in, local captures upload first —
  // one-time, since the local key is cleared after a successful upload.
  useEffect(() => {
    if (!authReady) return
    let cancelled = false
    setLoading(true)

    // Started here, synchronously, before this effect's first await: the plan
    // effect runs immediately after this one in the same commit and reads the
    // ref, so it has to be set by the time control leaves this line.
    const recipesMigrated = userId ? migrateLocalRecipes(userId) : Promise.resolve()
    recipesMigratedRef.current = recipesMigrated

    ;(async () => {
      try {
        await recipesMigrated
        const { rows, stale } = await withMirror(userId && cacheKeys.recipes(userId), () =>
          store.list(),
        )
        if (!cancelled) {
          setRecipes(rows)
          setOffline(stale)
          setError('')
          // The backfill. Anything still pointing at an origin gets mirrored
          // now, quietly, a couple at a time — including everything that just
          // came up from localStorage on a first sign-in. Not awaited: the list
          // is on screen and this is housekeeping behind it.
          if (!stale) mirrorImages(rows)
        }
      } catch (err) {
        if (!cancelled) setError(readError(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [authReady, userId, store, mirrorImages])

  // The plan is fetched a week at a time, so this re-runs on navigation as
  // well as on sign-in. Recipes migrate before plan rows do: meal_plan.recipe_id
  // is a foreign key, and migrateLocalRecipes keeps the local ids, so the
  // references still resolve after the move. That ordering is enforced by
  // recipesMigratedRef above, not by the order these effects are declared in.
  //
  // Both return { rows, stale } from the offline mirror rather than a bare
  // array, so the mount effect and the resume refetch below share one code path
  // for the fallback.
  const loadPlan = useCallback(async () => {
    const from = toISODate(weekStart)
    const to = toISODate(addDays(weekStart, 6))
    const key = userId && cacheKeys.plan(userId, from)
    return withMirror(key, () => planStore.listWeek(from, to))
  }, [planStore, userId, weekStart])

  const loadOverlay = useCallback(async () => {
    const week = toISODate(weekStart)
    const key = userId && cacheKeys.shopping(userId, week)
    return withMirror(key, () => shoppingStore.listWeek(week))
  }, [shoppingStore, userId, weekStart])

  useEffect(() => {
    if (!authReady) return
    let cancelled = false
    ;(async () => {
      try {
        // Wait for the recipes to be in the cloud before uploading rows that
        // reference them. Already resolved on a week change; this only really
        // waits on the first pass after a sign-in.
        if (recipesMigratedRef.current) await recipesMigratedRef.current
        if (userId) {
          // Left here rather than chained onto the promise above so that a
          // failure still retries: the local key survives a failed upload, and
          // both of these are a no-op once it has been cleared.
          await migrateLocalPlan(userId)
          await migrateLocalShopping(userId)
        }
        const [planned, overlaid] = await Promise.all([loadPlan(), loadOverlay()])
        if (!cancelled) {
          setPlan(planned.rows)
          setOverlay(overlaid.rows)
          if (planned.stale || overlaid.stale) setOffline(true)
        }
      } catch (err) {
        if (!cancelled) setError(readError(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [authReady, userId, loadPlan, loadOverlay])

  // The cooked log is not week-scoped, so it loads once per account rather than
  // with the plan. Declared after the recipes effect on purpose: it waits on the
  // same migration ref, since cook_log.recipe_id is a foreign key into recipes.
  const loadCookLog = useCallback(
    () => withMirror(userId && cacheKeys.cooklog(userId), () => cookStore.list()),
    [cookStore, userId],
  )

  useEffect(() => {
    if (!authReady) return
    let cancelled = false
    // A different account (or none) starts from an empty log: the merge below
    // keeps rows already in state, which must not be the last account's.
    setCookLog([])
    ;(async () => {
      try {
        if (recipesMigratedRef.current) await recipesMigratedRef.current
        if (userId) {
          // On its own: a failed upload (the local key survives, so it retries
          // next visit) must not stop the log that is already in the cloud loading.
          try {
            await migrateLocalCookLog(userId)
          } catch {
            // Retried on the next load; the local rows are untouched.
          }
        }
        const logged = await loadCookLog()
        // Merged, not assigned: a cook logged while this load was in flight is
        // already in state and not yet in what came back, and replacing the list
        // would drop it from the counts until the next refresh.
        if (!cancelled) {
          setCookLog((prev) => {
            const have = new Set(logged.rows.map((r) => r.id))
            return [...logged.rows, ...prev.filter((r) => !have.has(r.id))]
          })
        }
      } catch {
        // Display only: without it the counts and the cooked sorts read as
        // "never cooked" for this visit, and nothing else is affected.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [authReady, userId, loadCookLog])

  // Re-read the store without the auth/migrate work the mount effect does.
  // An installed PWA is resumed, not reloaded, so without this it shows the
  // list it fetched the first time it opened — a capture made in the browser
  // never appears. Skipped mid-import: that flow has already prepended the new
  // recipe optimistically, and a list fetched before the write landed would
  // wipe it back out.
  const refresh = useCallback(async (opts) => {
    if (importingRef.current || refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    const startedAt = Date.now()
    try {
      // Both, in parallel: the plan goes stale on resume for exactly the same
      // reason the recipe list does, and a plan row is meaningless without the
      // recipe it points at.
      const [listed, planned, overlaid, logged] = await Promise.all([
        withMirror(userId && cacheKeys.recipes(userId), () => store.list()),
        loadPlan(),
        loadOverlay(),
        // A failed read of the log must not fail the refresh: counts are display.
        loadCookLog().catch(() => null),
      ])
      setRecipes(listed.rows)
      setPlan(planned.rows)
      setOverlay(overlaid.rows)
      // Not when it came from the mirror: a failed read serves the last copy, and
      // that would replace a log this session has already added to or taken from.
      if (logged && !logged.stale) setCookLog(logged.rows)
      setOffline(listed.stale || planned.stale || overlaid.stale)
      setError('')
      // Catches anything captured on another device since this one last looked,
      // and retries whatever was offline when the mirror last ran here.
      if (!listed.stale) mirrorImages(listed.rows)
    } catch (err) {
      setError(readError(err))
    } finally {
      // Signed out the store is localStorage, so this whole function can finish
      // inside a single frame. A pull that triggered one flashed the indicator
      // out of existence and read as though the gesture had done nothing, which
      // is worse than it being slow. Hold the spinner long enough to be seen —
      // only for the gesture, since nobody is watching the resume-time refresh.
      if (opts?.gesture) {
        const elapsed = Date.now() - startedAt
        if (elapsed < PULL_MIN_SPIN) {
          await new Promise((resolve) => setTimeout(resolve, PULL_MIN_SPIN - elapsed))
        }
      }
      refreshingRef.current = false
      setRefreshing(false)
    }
  }, [store, userId, loadPlan, loadOverlay, loadCookLog, mirrorImages])

  // The gesture and the resume-time refetch, both of which only ever call
  // `refresh`. Gated on authReady: a refetch before then runs against the
  // wrong store.
  const { pull, dragging } = usePullToRefresh(refresh, { enabled: authReady })

  useEffect(() => {
    importingRef.current = importing
  }, [importing])

  // Hold off service worker update checks during a capture. An update reloads
  // the page, which would discard whatever is in the paste box — or the photo
  // just taken, which is worse, since retyping is possible and re-taking a
  // picture of somebody's cookbook at their house is not.
  useEffect(() => {
    setBusy(importing || pasteText.trim().length > 0 || Boolean(photo))
  }, [importing, pasteText, photo])

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
    setSavedPartial(false)
    try {
      const recipe = await extractRecipe(url)
      const saved = await store.save({
        ...recipe,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
      })
      setRecipes((prev) => [saved, ...prev])
      setImportUrl('')
      setCaptureOpen(false)
      setOpenId(saved.id)
      setSavedTitle(saved.title)
      // A caption that lists ingredients and leaves the method to the video is a
      // normal import, not an error, so it can't go through setError. But it is
      // still a partial recipe, and finding that out by scrolling to an empty
      // Steps heading is how it used to go.
      setSavedPartial(saved.ingredients.length > 0 && saved.instructions.length === 0)
      // Now, while the URL the origin just gave us is at its freshest. Not
      // awaited: the recipe is already on screen with its photo showing.
      mirrorImages([saved])
    } catch (err) {
      setError(writeError(err))
    } finally {
      setImporting(false)
    }
  }

  function handleImport(e) {
    e.preventDefault()
    importFromUrl(importUrl.trim())
  }

  function handleImportPaste(e) {
    // Share sheets copy the link with prose around it, which a type="url"
    // field would reject on submit.
    const text = e.clipboardData?.getData('text') || ''
    const match = text.match(/https?:\/\/\S+/)
    if (match && match[0] !== text.trim()) {
      e.preventDefault()
      setImportUrl(match[0])
    }
  }

  function closeCaptureSheet() {
    setCaptureOpen(false)
  }

  // The explicit "never mind" inside the paste-text view, as opposed to
  // dismissing the whole sheet — that one leaves the draft in place in case the
  // dismissal was a stray tap on the backdrop, since this box can hold a whole
  // pasted recipe.
  function closePasteText() {
    setPasteOpen(false)
    setPasteText('')
    clearPhoto()
  }

  function writeFromCapture() {
    setCaptureOpen(false)
    setEditing({ recipe: null })
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

  // Shrinking and encoding happen the moment a photo is picked rather than at
  // submit, so the preview and the bytes that get sent are the same thing and
  // there is nothing left to fail once the button is pressed.
  async function handlePickPhoto(file) {
    setError('')
    try {
      const next = await readPhoto(file)
      setPhoto((prev) => {
        if (prev) URL.revokeObjectURL(prev.preview)
        return next
      })
    } catch (err) {
      setError(err instanceof PhotoError ? err.message : writeError(err))
    }
  }

  function clearPhoto() {
    setPhoto((prev) => {
      if (prev) URL.revokeObjectURL(prev.preview)
      return null
    })
  }

  // One submit for both, because the view is one question: here is a recipe,
  // read it. Which endpoint answers depends only on whether a photo is attached.
  async function handlePasteText(e) {
    e.preventDefault()
    const text = pasteText.trim()
    if (importing) return
    if (!photo && text.length < 20) return
    setImporting(true)
    setError('')
    try {
      const recipe = photo ? await structureImage(photo.base64) : await structureText(text)
      const saved = await store.save({
        ...recipe,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
      })
      setRecipes((prev) => [saved, ...prev])
      setPasteText('')
      clearPhoto()
      setPasteOpen(false)
      setCaptureOpen(false)
      setOpenId(saved.id)
      mirrorImages([saved])
    } catch (err) {
      setError(writeError(err))
    } finally {
      setImporting(false)
    }
  }

  // Favoriting and tagging are the same write: the whole recipe back through
  // store.save, which upserts by id on both backends. Optimistic, because a star
  // that waits on a round trip feels broken; rolled back to the exact previous
  // recipe if the write fails.
  async function updateRecipe(recipe, patch) {
    const next = { ...recipe, ...patch }
    setRecipes((prev) => prev.map((r) => (r.id === recipe.id ? next : r)))
    try {
      const saved = await store.save(next)
      setRecipes((prev) => prev.map((r) => (r.id === recipe.id ? saved : r)))
    } catch (err) {
      setRecipes((prev) => prev.map((r) => (r.id === recipe.id ? recipe : r)))
      setError(writeError(err))
    }
  }

  function handleToggleFavorite(recipe) {
    return updateRecipe(recipe, { favorite: !recipe.favorite })
  }

  // Log a cook. Optimistic, like the planner: the line on the open recipe should
  // say "Cooked once" the instant the button is pressed. Returns the row's id so
  // the sheet can offer to take it back; a failed write removes the row again and
  // says so, and returns null (never throws, because cook mode's Done calls this
  // on its way out and must not be stopped by it).
  async function handleCooked(recipeId) {
    const row = { id: crypto.randomUUID(), recipe_id: recipeId, cooked_at: new Date().toISOString() }
    setCookLog((prev) => [...prev, row])
    try {
      const saved = await cookStore.add(row)
      setCookLog((prev) => prev.map((r) => (r.id === row.id ? saved : r)))
      // Not appended twice: a refresh that landed between the insert and here has
      // already written this row into the mirror.
      updateMirror(userId && cacheKeys.cooklog(userId), (rows) =>
        rows.some((r) => r.id === saved.id) ? rows : [...rows, saved],
      )
      return saved.id
    } catch (err) {
      setCookLog((prev) => prev.filter((r) => r.id !== row.id))
      setError(writeError(err))
      return null
    }
  }

  async function handleUndoCooked(id) {
    const before = cookLog
    setCookLog((prev) => prev.filter((r) => r.id !== id))
    try {
      await cookStore.remove(id)
      updateMirror(userId && cacheKeys.cooklog(userId), (rows) => rows.filter((r) => r.id !== id))
    } catch (err) {
      setCookLog(before)
      setError(writeError(err))
    }
  }

  // Notes, like the editor's save and unlike updateRecipe: it throws, so the
  // sheet keeps the draft and says the note did not save instead of closing on a
  // lie. Blank clears the note.
  async function handleSaveNotes(recipe, text) {
    const notes = text.trim() ? text.trim().slice(0, 4000) : null
    const saved = await store.save({ ...recipe, notes })
    setRecipes((prev) => prev.map((r) => (r.id === saved.id ? saved : r)))
  }

  // The editor's save, which is deliberately not updateRecipe: that one is
  // optimistic and swallows its failure into the error strip, which is right for
  // a star and wrong for a form. Here the sheet stays open and shows what went
  // wrong, so the typing isn't lost — hence the throw rather than a catch.
  async function handleEditorSave(values) {
    // `photo` is bytes for the upload below, not a column: it never reaches the store.
    const { photo, ...fields } = values
    const target = editing?.recipe
    const previousImage = target?.image_url || null
    // A new recipe whose photo failed to upload is already saved. Saving again
    // must update that row, not create a second recipe with the same title.
    const draft = newDraft.current

    // Step sections (`instruction_groups`) run parallel to the steps, and the
    // editor knows nothing of them. Where the steps were added, removed or
    // reordered the old array no longer lines up with them, and the step
    // ingredients would show the wrong section's lines: so it goes. (`toRow`
    // writes the null, which clears the column.)
    const stepsChanged =
      target?.instruction_groups &&
      JSON.stringify(target.instructions) !== JSON.stringify(fields.instructions)

    const saved = await store.save(
      target
        ? { ...target, ...fields, ...(stepsChanged && { instruction_groups: null }) }
        : {
            ...fields,
            source_type: 'manual',
            favorite: false,
            id: draft?.id || crypto.randomUUID(),
            created_at: draft?.created_at || new Date().toISOString(),
          },
    )

    // Replaced if it is already in the list (an edit, or a retry after a failed
    // photo), added otherwise.
    const place = (row) => (prev) =>
      prev.some((r) => r.id === row.id) ? prev.map((r) => (r.id === row.id ? row : r)) : [row, ...prev]
    setRecipes(place(saved))
    setOpenId(saved.id)

    // A photo the person picked. It goes up after the save because the backend
    // checks the recipe is theirs, and in place of the link mirror: the link
    // field was cleared when the photo was picked.
    if (photo) {
      try {
        const supabase = await getSupabase()
        const { data } = await supabase.auth.getSession()
        const token = data?.session?.access_token
        if (!token) throw new Error('not signed in')
        const columns = await uploadRecipeImage(saved.id, photo, token)
        const withPhoto = await store.saveImage(saved.id, columns)
        if (!withPhoto) throw new Error('recipe not found')
        setRecipes(place(withPhoto))
        newDraft.current = null
        return withPhoto
      } catch (err) {
        if (!target) newDraft.current = { id: saved.id, created_at: saved.created_at }
        // The editor keeps its sheet and the picked photo when this throws, so
        // saving again retries just the photo.
        throw new Error(
          navigator.onLine
            ? "The recipe is saved, but the photo didn't upload. Save again to retry the photo."
            : "You're offline. The recipe is saved, but the photo didn't upload. Save again when you're back online.",
          { cause: err },
        )
      }
    }

    // A pasted photo link is mirrored on exactly the same terms as an imported
    // one. The per-session set is keyed by recipe id, so a recipe whose earlier
    // photo failed to mirror would be skipped forever with its new one — drop
    // the claim when the link actually changed.
    if ((saved.image_url || null) !== previousImage) mirrored.current.delete(saved.id)
    mirrorImages([saved])
    return saved
  }

  // No handleSetTags any more: tags are read-only in the open recipe as of
  // pass 2 (finding 15) and the editor is the one place they change.

  function handleToggleTag(tag) {
    setActiveTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))
  }

  function clearFilters() {
    setQuery('')
    setActiveTags([])
    setFavoritesOnly(false)
  }

  // "Open recipe" on a finished timer (components/Timers.jsx). Filters are
  // cleared first: the list only opens a recipe it is currently showing, so a
  // search left in the box would swallow the jump.
  useEffect(() => {
    function onOpenRecipe(e) {
      setTab('recipes')
      setQuery('')
      setActiveTags([])
      setFavoritesOnly(false)
      setOpenId(e.detail)
    }
    window.addEventListener(OPEN_RECIPE_EVENT, onOpenRecipe)
    return () => window.removeEventListener(OPEN_RECIPE_EVENT, onOpenRecipe)
  }, [])

  async function handleDelete(id) {
    try {
      await store.remove(id)
      setRecipes((prev) => prev.filter((r) => r.id !== id))
      // Postgres cascades this via the foreign key; the local backend has no
      // such thing, so it is done by hand there. Either way the rows are gone,
      // so drop them from view without a refetch.
      await planStore.removeByRecipe(id)
      setPlan((prev) => prev.filter((e) => e.recipe_id !== id))
      await cookStore.removeByRecipe(id)
      setCookLog((prev) => prev.filter((r) => r.recipe_id !== id))
      updateMirror(userId && cacheKeys.cooklog(userId), (rows) => rows.filter((r) => r.recipe_id !== id))
      if (openId === id) setOpenId(null)
    } catch (err) {
      setError(writeError(err))
    }
  }

  function changeWeek(direction) {
    // 0 means "back to today", which is its own case rather than an offset.
    setWeekStart((prev) => (direction === 0 ? startOfWeek(new Date()) : addDays(prev, direction * 7)))
  }

  // `servings` is how many the meal is for; null/undefined means "as the recipe
  // says". It only moves the quantities the shopping list gathers.
  async function handleAssign(recipeId, dateISO, slot, servings = null, leftover = false) {
    const entry = {
      id: crypto.randomUUID(),
      recipe_id: recipeId,
      plan_date: dateISO,
      slot,
      servings,
      leftover: Boolean(leftover),
      created_at: new Date().toISOString(),
    }
    // Optimistic: the sheet closes on tap, so waiting on the round trip would
    // show an empty day for as long as the write takes.
    setPlan((prev) => [...prev, entry])
    try {
      const saved = await planStore.add(entry)
      setPlan((prev) => prev.map((e) => (e.id === entry.id ? saved : e)))
      return true
    } catch (err) {
      setPlan((prev) => prev.filter((e) => e.id !== entry.id))
      setError(writeError(err))
      return false
    }
  }

  // Adding from the open recipe (finding 16) offers the next seven days, which
  // routinely reaches past Saturday — and App only holds one week of plan rows,
  // so the meal would land correctly in the database and then be invisible on a
  // planner still showing the week you started from. It reads as the add having
  // failed. So the planner follows the meal.
  //
  // After the write, not before: the week change is what `loadPlan` keys off,
  // and a refetch that beat the insert would come back without the new row and
  // replace the optimistic copy with nothing.
  async function handlePlanFromRecipe(recipeId, dateISO, slot, servings) {
    const added = await handleAssign(recipeId, dateISO, slot, servings)
    if (added) setWeekStart(startOfWeek(fromISODate(dateISO)))
  }

  // Change a planned meal's day, slot or servings. Optimistic, and put back
  // exactly as it was if the write fails.
  async function handleUpdateEntry(id, patch) {
    const before = plan.find((e) => e.id === id)
    if (!before) return
    setPlan((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)))
    try {
      const saved = await planStore.update(id, patch)
      if (saved) setPlan((prev) => prev.map((e) => (e.id === id ? saved : e)))
    } catch (err) {
      setPlan((prev) => prev.map((e) => (e.id === id ? before : e)))
      setError(writeError(err))
    }
  }

  // The planner row's "Open recipe". Filters are cleared for the same reason the
  // timer jump clears them: the list only opens a recipe it is showing.
  function handleOpenRecipe(id) {
    setTab('recipes')
    clearFilters()
    setOpenId(id)
  }

  // "To list" on the recipe sheet: ingredient lines added as hand-style items to
  // the week on screen, each remembering which recipe it came from. Throws on a
  // failed write (after taking the optimistic rows back out) so the sheet can say
  // so, and resolves to the week's label for its confirmation.
  async function handleAddToList(recipe, lines) {
    const week = toISODate(weekStart)
    const rows = lines.slice(0, 80).map((text) => ({
      id: crypto.randomUUID(),
      recipe_id: recipe.id,
      week_start: week,
      name: text.slice(0, 200),
      kind: 'manual',
      checked: false,
      created_at: new Date().toISOString(),
    }))
    setOverlay((prev) => [...prev, ...rows])
    try {
      const saved = await Promise.all(rows.map((row) => shoppingStore.add(row)))
      const byId = new Map(saved.map((s, i) => [rows[i].id, s]))
      setOverlay((prev) => prev.map((r) => byId.get(r.id) || r))
      return weekRangeLabel(weekStart)
    } catch (err) {
      const ids = new Set(rows.map((r) => r.id))
      setOverlay((prev) => prev.filter((r) => !ids.has(r.id)))
      throw err
    }
  }

  // Ticking a derived line writes a check row the first time and updates it
  // afterwards. There is no unique constraint to upsert against, and adding one
  // for a partial index is more trouble through PostgREST than just looking.
  async function handleToggleDerived(key, checked) {
    // week_start is part of the match because state can still be holding another
    // week's rows if a week change failed to fetch, and two weeks can easily
    // have a line with the same merge key.
    const existing = overlay.find(
      (row) => row.kind === 'check' && row.name === key && row.week_start === toISODate(weekStart),
    )
    const before = overlay
    if (existing) {
      setOverlay((prev) => prev.map((r) => (r.id === existing.id ? { ...r, checked } : r)))
      try {
        await shoppingStore.update(existing.id, { checked })
      } catch (err) {
        setOverlay(before)
        setError(writeError(err))
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
      setError(writeError(err))
    }
  }

  async function handleToggleManual(id, checked) {
    const before = overlay
    setOverlay((prev) => prev.map((r) => (r.id === id ? { ...r, checked } : r)))
    try {
      await shoppingStore.update(id, { checked })
    } catch (err) {
      setOverlay(before)
      setError(writeError(err))
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
      setError(writeError(err))
    }
  }

  async function handleRemoveManual(id) {
    const before = overlay
    setOverlay((prev) => prev.filter((r) => r.id !== id))
    try {
      await shoppingStore.remove(id)
    } catch (err) {
      setOverlay(before)
      setError(writeError(err))
    }
  }

  async function handleUnassign(id) {
    const removed = plan.find((e) => e.id === id)
    setPlan((prev) => prev.filter((e) => e.id !== id))
    try {
      await planStore.remove(id)
    } catch (err) {
      if (removed) setPlan((prev) => [...prev, removed])
      setError(writeError(err))
    }
  }

  const pullActive = pull > 0 || refreshing
  // How far through the gesture the finger is, 0 to 1. Everything the indicator
  // does is driven off this rather than off a set of thresholds, so the
  // feedback is continuous and the arming moment is something you watch arrive
  // instead of something you read.
  const pullProgress = refreshing ? 1 : Math.min(1, pull / PULL_TRIGGER)
  const armed = pullProgress >= 1
  const pullClass = [
    'rb-pull',
    pullActive && 'rb-pull-active',
    dragging && 'rb-pull-dragging',
    armed && !refreshing && 'rb-pull-armed',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="rb-app">
      <div
        className={pullClass}
        style={{
          transform: `translate3d(0, ${refreshing ? PULL_TRIGGER : pull}px, 0)`,
          opacity: refreshing ? 1 : Math.min(1, pullProgress * 1.4),
        }}
        aria-hidden={!pullActive}
      >
        <span className="rb-pull-pill">
          <span
            className={refreshing ? 'rb-pull-spinner rb-pull-spinning' : 'rb-pull-spinner'}
            // Sweeping the ring round as the finger travels is what makes the
            // gesture feel attached to the indicator rather than merely followed
            // by it; at full sweep it has visibly become the spinner it becomes.
            style={
              refreshing
                ? undefined
                : {
                    transform: `rotate(${pullProgress * 270}deg) scale(${0.7 + pullProgress * 0.3})`,
                  }
            }
          />
          <span className="rb-pull-label">
            {refreshing ? 'Refreshing…' : armed ? 'Release to refresh' : 'Pull to refresh'}
          </span>
        </span>
      </div>
      <header className="rb-header">
        <div className="rb-header-row">
          <div className="rb-brand">
            <h1 className="rb-wordmark">Recipe Box</h1>
            {import.meta.env.VITE_APP_STAGE === 'staging' && (
              <span className="rb-stage-badge">Staging</span>
            )}
          </div>
          <div className="rb-header-actions">
            <TimersButton />
            <Account
              session={session}
              recipes={recipes}
              exportReady={!loading && !offline}
              onWhatsNew={() => setNewsSheet('whatsnew')}
              onFeedback={() => setNewsSheet('feedback')}
            />
          </div>
        </div>
      </header>

      {/* Outside the tab switch: being offline affects the plan and the list
          equally, and the shopping tab is where it matters most. */}
      {offline && (
        <p className="rb-offline" role="status">
          <span>No connection. Showing the copy saved on this device.</span>
          <button
            type="button"
            className="btn btn-quiet rb-offline-retry"
            onClick={() => refresh()}
            disabled={refreshing}
          >
            {refreshing ? 'Retrying…' : 'Retry'}
          </button>
        </p>
      )}

      {tab === 'recipes' && (
        <main className="rb-main">
          {/* Below every notice about something that just happened: news can
              wait a screen, a share that's saving or a recipe just saved can't. */}
          {!newsClosed && !offline && !fromShare && !savedTitle && !shareNotice && (
            <NewsBanner
              entry={news}
              onWhatsNew={() => setNewsSheet('whatsnew')}
              onDismiss={(e) => {
                markNewsSeen(news.id)
                setNewsClosed(true)
                // The button is about to vanish, which drops focus to <body>.
                // Hand it to the list it sat above instead; not the search
                // field, which would open the keyboard on a phone.
                const main = e.currentTarget.closest('main')
                main?.setAttribute('tabindex', '-1')
                main?.focus({ preventScroll: true })
              }}
            />
          )}
          {fromShare && importing && (
            <p className="rb-notice">Saving the shared link…</p>
          )}
          {savedTitle && (
            <p className="rb-saved">
              <span>
                Saved “{savedTitle}”.
                {savedPartial && ' The source had no steps, so only the ingredients came across.'}
                {fromShare && ' You can close this tab.'}
                {supabaseEnabled && !userId && ' Sign in to sync it to your other devices.'}
              </span>
              <button type="button" className="btn btn-quiet rb-notice-close" onClick={() => {
                  setSavedTitle('')
                  setSavedPartial(false)
                }}
              >
                Dismiss
              </button>
            </p>
          )}
          {shareNotice && (
            <p className="rb-notice">
              A share arrived without a link in it. Copy the post link, then tap + to add it.
              <button type="button" className="btn btn-quiet rb-notice-close" onClick={() => setShareNotice(false)}>
                Dismiss
              </button>
            </p>
          )}
          {error && !captureOpen && (
            <p className="rb-error" role="alert">
              {error}
            </p>
          )}

          <RecipeList
            recipes={recipes}
            loading={loading || importing}
            query={query}
            onQueryChange={setQuery}
            activeTags={activeTags}
            onToggleTag={handleToggleTag}
            favoritesOnly={favoritesOnly}
            onToggleFavoritesOnly={() => setFavoritesOnly((v) => !v)}
            onClearFilters={clearFilters}
            openId={openId}
            onOpen={setOpenId}
            onDelete={handleDelete}
            onToggleFavorite={handleToggleFavorite}
            onAssign={handlePlanFromRecipe}
            onToList={handleAddToList}
            cookStats={cookStats}
            onCooked={handleCooked}
            onUndoCooked={handleUndoCooked}
            onSaveNotes={handleSaveNotes}
            onEdit={(recipe) => setEditing({ recipe })}
            onWrite={() => setEditing({ recipe: null })}
            onCapture={() => setCaptureOpen(true)}
          />
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
            onUpdate={handleUpdateEntry}
            onOpenRecipe={handleOpenRecipe}
          />
          {error && (
            <p className="rb-error" role="alert">
              {error}
            </p>
          )}
        </main>
      )}

      {tab === 'shopping' && (
        <main className="rb-main">
          <ShoppingList
            weekStart={weekStart}
            plan={plan}
            recipes={recipes}
            overlay={overlay}
            prefs={prefs}
            onChangePrefs={handleChangePrefs}
            onWeekChange={changeWeek}
            onToggleDerived={handleToggleDerived}
            onToggleManual={handleToggleManual}
            onAddManual={handleAddManual}
            onRemoveManual={handleRemoveManual}
            onUnassign={handleUnassign}
          />
          {error && (
            <p className="rb-error" role="alert">
              {error}
            </p>
          )}
        </main>
      )}

      {/* Floating above the tab bar rather than in the header: the tabs moved
          down here in pass 1b for the same reason — it's where a thumb already
          is. Recipes-only, since capture is what this tab is for. */}
      {tab === 'recipes' && !editing && (
        <div className="rb-fab-wrap">
          <button
            type="button"
            className="btn btn-primary rb-fab"
            aria-label="Add a recipe"
            onClick={() => setCaptureOpen(true)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" focusable="false">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      )}

      {captureOpen && (
        <CaptureSheet
          importUrl={importUrl}
          onImportUrlChange={setImportUrl}
          onImportPaste={handleImportPaste}
          onImportSubmit={handleImport}
          importing={importing}
          canPaste={canPaste}
          onPasteLink={pasteLink}
          pasteOpen={pasteOpen}
          onOpenPasteText={() => setPasteOpen(true)}
          onClosePasteText={closePasteText}
          pasteText={pasteText}
          onPasteTextChange={setPasteText}
          onPasteTextSubmit={handlePasteText}
          photo={photo}
          onPickPhoto={handlePickPhoto}
          onClearPhoto={clearPhoto}
          onWrite={writeFromCapture}
          onClose={closeCaptureSheet}
          error={error}
          inputRef={inputRef}
        />
      )}

      {editing && (
        <RecipeEditor
          // Keyed so switching from one recipe to another rebuilds the form
          // rather than leaving the previous recipe's rows in state.
          key={editing.recipe?.id || 'new'}
          recipe={editing.recipe}
          onSave={handleEditorSave}
          onClose={() => {
            newDraft.current = null
            setEditing(null)
          }}
          canUploadPhoto={Boolean(userId && supabaseEnabled)}
        />
      )}

      {newsSheet === 'whatsnew' && (
        <WhatsNewSheet onClose={() => setNewsSheet(null)} onFeedback={() => setNewsSheet('feedback')} />
      )}
      {newsSheet === 'feedback' && (
        <FeedbackSheet signedIn={Boolean(userId)} onClose={() => setNewsSheet(null)} />
      )}

      {/* One card at a time: the install card waits until the news is closed,
          or the Recipes tab opens with a notice at each end of the list. */}
      {/* Shown on the Recipes tab only. The card pins above the tab bar while
          there is more below it, which on the planner and the shopping list meant
          it sat over the rows being read or ticked (measured at 390px, iOS UA).
          It stays MOUNTED on every tab, though: Chrome fires beforeinstallprompt
          once per page load, and an unmounted card has no listener to catch it
          (found in review). */}
      <InstallPrompt ready={tab === 'recipes' && recipes.length > 0 && newsClosed} />

      {/* After every other sheet in the tree, so the list opens on top of a
          recipe or cook mode rather than behind it. */}
      <TimersSheet />
      <TimerTray current={openId} />

      <TabBar tab={tab} onChange={setTab} />
    </div>
  )
}
