# Recipe Box — Spec & Roadmap

Personal recipe manager + meal planner PWA. Replaces ReciMe (paid) with a self-hosted app on the existing Vercel + Supabase free-tier setup. Decisions made 2026-08-04.

## Core decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Stack | React + FastAPI on Vercel | Same shape as mtg-web; backend needed anyway (CORS blocks client-side scraping) |
| Storage | Supabase Postgres + auth | Cross-device sync, free tier, RLS pattern already proven in mtg-web |
| Social import | AI extraction from caption | oEmbed/yt-dlp pulls the caption, Haiku structures it; video transcription deferred |
| Discovery feed | Deferred past v1 | Legally/technically fuzzy; capture + planning is the real value |

## Extraction pipeline

1. **Recipe websites** — fetch HTML server-side, parse `<script type="application/ld+json">` for a schema.org `Recipe` object. Covers the vast majority of recipe sites (they mark up for Google). Fallback: microdata, then readable-text + AI extraction.
2. **TikTok / Instagram** — resolve the share URL, pull the post caption (oEmbed where available, yt-dlp metadata as fallback), send caption to Claude Haiku with a structuring prompt → normalized recipe JSON. Works when the creator wrote the recipe in the caption (very common). If no recipe in caption, save as a link card with thumbnail for manual fill-in.
3. **Manual** — plain form, plus paste-anything box that runs the same Haiku structurer.

Normalized recipe shape (matches `supabase/schema.sql`):

```json
{
  "title": "", "source_url": "", "source_type": "web|tiktok|instagram|manual",
  "image_url": "", "description": "",
  "ingredients": [{"raw": "200g spaghetti", "item": "spaghetti", "qty": "200", "unit": "g"}],
  "instructions": ["step 1", "step 2"],
  "prep_min": 10, "cook_min": 20, "total_min": 30,
  "servings": "4", "tags": [], "favorite": false
}
```

Ingredients keep the `raw` string always; parsed qty/unit/item are best-effort (needed later for shopping-list aggregation).

## Capture UX (the whole point)

- **PWA share target** — installed app appears in the OS share sheet; sharing from the TikTok/IG app lands directly in the import flow. This is the feature that kills capture friction. Manifest `share_target` is already configured (GET params: `url`, `text`, `title`).
- Paste a URL on the Recipes tab → import.
- Everything imports as editable — extraction is a head start, not gospel.

## v1 scope (user-confirmed)

Saving/importing recipes, weekly meal planner, shopping list, search/tags/collections. Discovery feed deferred.

## Phases

- **Phase 1 — Capture core (scaffolded):** FastAPI extract endpoint (JSON-LD), React shell with import bar + recipe list/detail, localStorage persistence, PWA manifest + share target wiring.
- **Phase 2 — Supabase (code done 2026-08-04):** schema from `supabase/schema.sql`, magic-link auth (mtg-web pattern, `components/Account.jsx`), one-time localStorage → cloud upload on sign-in (`lib/store.js`). Dedicated Supabase project, separate from mtg-web. App runs local-only until the env vars are set.
- **Phase 3 — Social import:** caption fetch (oEmbed/yt-dlp) + Haiku structuring endpoint; link-card fallback. Budget-capped like mtg-web's `_ai_call()`.
- **Phase 4 — Planner + shopping list:** week view, assign recipes to day/slot, aggregate ingredients across the planned week into a checklist (merge by item+unit where parseable, raw lines otherwise).
- **Phase 5 — Organization + polish:** search, tags, collections/favorites, offline caching of saved recipes, icon set, install prompt.

## Security notes

- `extract` endpoint fetches arbitrary user-supplied URLs → SSRF guard (public IPs only, http/https only, size cap, timeout) lives in `backend/app/extract.py`. Keep it on every new fetch path.
- Caption text is untrusted input to the AI structurer — wrap in `<user_input>` tags, injection defense in system prompt (vault-level rule).
- Pydantic models with Field constraints on all POST bodies; opaque client errors.

## Non-goals (for now)

Multi-user sharing/households, nutrition data, recipe scaling, discovery feed, native apps.
