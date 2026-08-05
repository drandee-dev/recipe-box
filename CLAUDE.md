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
- **AI:** `claude-haiku-4-5` structures captions and pasted text (`app/ai.py`). Uses **structured outputs** (`output_config.format` + `RECIPE_SCHEMA`) — the model cannot return prose, so never add fence-stripping or `json.loads` fallbacks around it. Schema rules: `additionalProperties: false` on every object, `required` must list every property, and no `minimum`/`maxLength`-style constraints. Spend is capped monthly via `app/usage.py` → Supabase `ai_usage_events`; both usage calls fail open so a Supabase outage never blocks an import.
- **Social import:** `app/social.py` — TikTok oEmbed (its `title` field is the caption), Instagram/other via og: tags. No caption or no recipe in it means a **link card**, not an error. Captions are untrusted: they stay wrapped in `<user_input>` tags with injection defense in the system prompt.

## Conventions

- Ingredients always keep the `raw` string; parsed qty/unit/item are best-effort (shopping list depends on them, phase 4).
- Every server-side URL fetch goes through the SSRF guard in `extract.py` — never `httpx.get` a user URL directly.
- Pydantic `BaseModel` + `Field` constraints on all POST bodies; log tracebacks server-side, return opaque errors.
- CSS classes prefixed by component scope (`rb-`, `recipes-`, `planner-`); base styles before `@media` in the cascade.
- PWA share target params (`url`, `text`, `title`) are read by `readShare()` in `App.jsx` on load, then stripped from the URL with `replaceState` — that strip must never touch Supabase's auth-callback params. Don't break the query-string handling.
- iOS drops those params entirely when launching an installed home-screen app (verified 2026-08-04), so the clipboard `Paste copied link` button is the real iPhone capture path — keep it working.
