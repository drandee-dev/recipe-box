# Recipe Box

Personal PWA for saving recipes from anywhere — recipe websites, TikTok, Instagram — into one searchable place, plus weekly meal planning and an auto-built shopping list. Self-hosted alternative to ReciMe.

## Stack

- **Frontend:** React 19 + Vite PWA (installable, offline shell, share target) → Vercel
- **Backend:** FastAPI as a single Vercel Python Function → Vercel
- **Storage:** Supabase (Postgres + magic-link auth, RLS per user), localStorage fallback
- **AI:** Claude Haiku structures recipes out of TikTok/Instagram captions

## Dev setup

```bash
# Backend — port 8002 (mtg-web owns 8001)
cd backend
pip install -r requirements.txt
uvicorn app.main:app --port 8002

# Frontend
cd frontend
npm install
npm run dev   # http://localhost:5173
```

`frontend/.env` needs `VITE_API_BASE=http://localhost:8002`. For cloud sync, also set `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (dedicated Supabase project, run `supabase/schema.sql` there first); leave them unset to run local-only.

## Status

Phase 1 (URL import via schema.org JSON-LD + local recipe list) scaffolded. Phase 2 (Supabase auth + cloud sync) built 2026-08-04 — recipes route through `frontend/src/lib/store.js`, local captures upload once on sign-in. See `docs/SPEC.md` for the full plan and phase breakdown.

PWA icons (`frontend/public/pwa-192.png`, `pwa-512.png`) still need generating before install prompts work.
