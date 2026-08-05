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
- **AI (phase 3):** Claude Haiku structures captions/pasted text into recipe JSON. Reuse mtg-web's `_ai_call()` budget-cap pattern.

## Conventions

- Ingredients always keep the `raw` string; parsed qty/unit/item are best-effort (shopping list depends on them, phase 4).
- Every server-side URL fetch goes through the SSRF guard in `extract.py` — never `httpx.get` a user URL directly.
- Pydantic `BaseModel` + `Field` constraints on all POST bodies; log tracebacks server-side, return opaque errors.
- CSS classes prefixed by component scope (`rb-`, `recipes-`, `planner-`); base styles before `@media` in the cascade.
- PWA share target params (`url`, `text`, `title`) are read in `App.jsx` on load — don't break that query-string handling.
