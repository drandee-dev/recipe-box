# Recipe Box — Claude Code Context

> Project-specific guidance. Security, token efficiency, and writing rules are in the vault-level `CLAUDE.md`. Full plan: `docs/SPEC.md`.

## Quick start

```bash
# Backend (FastAPI) — ⚠ port 8002 (mtg-web owns 8001)
cd backend && uvicorn app.main:app --port 8002
# Run WITHOUT --reload on Windows — reload leaves zombie workers holding the port

# Frontend (React/Vite)
cd frontend && npm run dev   # http://localhost:5173 — .env VITE_API_BASE must point at 8002
```

CORS defaults to `localhost:5173`/`4173`; set `RECIPE_CORS_ORIGINS` (comma-separated) if Vite picks another port. Config in `backend/app/config.py`.

## Architecture

- **Frontend:** React 19 + Vite + vite-plugin-pwa, JSX (not TS) to match mtg-web conventions. State centralized in `App.jsx`, props down, no state library. Recipes go through the store abstraction in `src/lib/store.js` — localStorage `recipebox:recipes` when signed out, Supabase `recipes` table when signed in. On sign-in, local captures upload once and the local key is cleared (cloud becomes source of truth).
- **Backend:** single Vercel Python Function from `app/main.py`, deployed at **recipe-box-api-sage.vercel.app** (project `recipe-box-api`, FastAPI framework preset, root dir `backend`, zero-config — no vercel.json; fluid compute default 300s maxDuration). `app/extract.py` holds the scraping pipeline. Dotdash Meredith sites (AllRecipes, Serious Eats) block Vercel IPs — extraction fails there by design of their bot protection.
- **Frontend deploy:** **recipe-box-coral.vercel.app** (project `recipe-box`, Vite preset, root dir `frontend`). Env vars `VITE_API_BASE`/`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` are build-time — changing them requires a redeploy. Both projects build on every push to `main` (github.com/dreandyyttv-bot/recipe-box).
- **Storage:** Supabase, dedicated project (NOT shared with mtg-web) — schema in `supabase/schema.sql`, RLS per user, magic-link auth in `src/components/Account.jsx`, client in `src/lib/supabase.js`. Env vars unset = local-only mode (no auth UI rendered).
- **AI:** `claude-haiku-4-5` structures captions and pasted text (`app/ai.py`). Uses **structured outputs** (`output_config.format` + `RECIPE_SCHEMA`) — the model cannot return prose, so never add fence-stripping or `json.loads` fallbacks around it. Schema rules: `additionalProperties: false` on every object, `required` must list every property, and no `minimum`/`maxLength`-style constraints. `enum` *is* in the supported subset and is what pins `tags` to `ALLOWED_TAGS`. Spend is capped monthly via `app/usage.py` → Supabase `ai_usage_events`; both usage calls fail open so a Supabase outage never blocks an import.
- **Social import:** `app/social.py` — TikTok oEmbed (its `title` field is the caption), Instagram/other via og: tags. No caption or no recipe in it means a **link card**, not an error. Captions are untrusted: they stay wrapped in `<user_input>` tags with injection defense in the system prompt.

## Conventions

- Ingredients always keep the `raw` string; parsed qty/unit/item are best-effort (shopping list depends on them, phase 4b). Note `extract.py` sets all three to `null` on the JSON-LD path, so only AI-structured recipes have them.
- Planner dates go through `lib/dates.js` and stay in local time. `plan_date` is a zoneless Postgres `date`, so `toISOString()` would save an evening assignment under the previous day west of Greenwich. Weeks start Sunday.
- New stores mirror `lib/store.js`: a localStorage backend, a Supabase backend, one `make*Store(userId)` picker, and a one-time migrate on sign-in. `lib/plan.js` and `lib/shopping.js` follow it. Plan rows migrate *after* recipes because `meal_plan.recipe_id` is a foreign key and the recipe upload preserves local ids.
- **The shopping list is derived, not stored.** It recomputes from the week's plan every render, so it can never drift and there is no regenerate step. `shopping_items` holds only the overlay: `kind='check'` rows whose `name` is the merge key from `buildShoppingList`, and `kind='manual'` rows for hand-added items. Don't "fix" this by materialising the list — the `kind` column exists specifically so an orphaned check can't resurface as a phantom manual item after a plan change.
- **Tags are the collection mechanism** — there is no collections table, and adding one would duplicate what `tags text[]` already does. The AI may only use tags from `ALLOWED_TAGS` (`app/ai.py`, schema-enforced), mirrored in `lib/tags.js` for the editor's suggestions; **the two lists must be updated together**. Hand-typed tags are intentionally *not* restricted to that list. Filter chips come from `tagCounts(recipes)` — tags in use — never from the vocabulary, so a chip always leads somewhere.
- Search (`filterRecipes` in `lib/tags.js`) ANDs terms and does not read `instructions`. Adding a field can only widen an ANDed result set, and step text is mostly words every recipe contains, so including it would make each term match more rather than narrow better.
- Ingredient parsing (`lib/ingredients.js`) never invents detail: a line it can't parse goes to the list verbatim and merges with nothing. Same-item-different-unit stays as separate lines rather than converting, since a quiet unit-conversion error is only discovered in the shop. Aisle mapping is a keyword list matched longest-first, which is what keeps `bell pepper` in Produce and `garlic powder` out of it.
- A merged line keeps `sources` — per-recipe contributions, with a `times` count so a recipe planned twice in one week reads as `Pasta ×2 4 cups` rather than an unexplained double.
- Variant grouping (`BASE_INGREDIENTS`) is curated, not derived. Head-noun extraction would file olive oil and sesame oil together as "oil". Grouping happens **only inside one aisle**, which is what stops bell pepper and black pepper from meeting, and it never sums across variants: 2 breasts plus 4 thighs is not 6 of anything. A base needs two or more variants present before it earns a heading.
- Every server-side URL fetch goes through the SSRF guard in `extract.py` — never `httpx.get` a user URL directly.
- Pydantic `BaseModel` + `Field` constraints on all POST bodies; log tracebacks server-side, return opaque errors.
- CSS classes prefixed by component scope (`rb-`, `recipes-`, `planner-`); base styles before `@media` in the cascade.
- PWA share target params (`url`, `text`, `title`) are read by `readShare()` in `App.jsx` on load, then stripped from the URL with `replaceState` — that strip must never touch Supabase's auth-callback params. Don't break the query-string handling.
- iOS drops those params entirely when launching an installed home-screen app (verified 2026-08-04), so the clipboard `Paste copied link` button is the real iPhone capture path — keep it working.
- An installed PWA is **resumed, not reloaded**, so the mount-time recipe load in `App.jsx` never re-runs and a capture made in the browser stays invisible. Two things fix that and both must survive refactors: the foreground refetch (`visibilitychange`/`focus`/`pageshow`) and pull-to-refresh. Note the load effect's deps (`authReady`, `userId`, `store`) do not change on resume — `getSession()` returns a new object but `userId` is a stable string — so the effect cannot be relied on to refetch.
- The pull gesture uses native `touchmove` listeners with `{ passive: false }`, not React's `onTouchMove`, which React registers as passive so `preventDefault()` is ignored and iOS rubber-bands instead. `overscroll-behavior-y: contain` on `body` is load-bearing for the same reason.
- **Service worker updates run through `src/lib/pwa.js`, not the plugin's injected script.** `injectRegister: null` is deliberate: the generated `registerSW.js` binds registration to the window `load` event, which a resumed PWA never fires, so an installed app served its install-day bundle forever. `pwa.js` registers the virtual module with `immediate: true` and calls `registration.update()` on resume. Checks are gated on `setBusy()` because `registerType: 'autoUpdate'` reloads the page when a new worker claims it, and reloading mid-capture would discard the paste box.
- Signed-in state does **not** cross between Safari and the installed app: the Supabase session lives in `localStorage` and an installed PWA has its own storage sandbox. Sign in once inside the PWA. Nothing in the app can share that session, so don't treat it as a bug.
