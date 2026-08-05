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

- **PWA share target** — installed app appears in the OS share sheet; sharing from the TikTok/IG app lands directly in the import flow. Manifest `share_target` is configured (GET params: `url`, `text`, `title`). **Android only.**
- **iOS capture (tested 2026-08-04):** iOS has no Web Share Target support, and the Shortcuts workaround also fails: the shortcut builds a correct `/?text=<link>` URL, but when the app is installed to the home screen iOS launches it at `start_url` and discards the query string. Both halves were verified correct in isolation, so this is an iOS routing behavior with no client-side fix. The working path on iPhone is **Copy link in the IG/TikTok share sheet, then "Paste copied link"** in the app (`navigator.clipboard.readText`). Shares that arrive with no link now show a visible notice instead of failing silently.
- Paste a URL on the Recipes tab → import.
- Everything imports as editable — extraction is a head start, not gospel.

## v1 scope (user-confirmed)

Saving/importing recipes, weekly meal planner, shopping list, search/tags/collections. Discovery feed deferred.

## Phases

- **Phase 1 — Capture core (scaffolded):** FastAPI extract endpoint (JSON-LD), React shell with import bar + recipe list/detail, localStorage persistence, PWA manifest + share target wiring.
- **Phase 2 — Supabase (code done 2026-08-04):** schema from `supabase/schema.sql`, magic-link auth (mtg-web pattern, `components/Account.jsx`), one-time localStorage → cloud upload on sign-in (`lib/store.js`). Dedicated Supabase project, separate from mtg-web. App runs local-only until the env vars are set.
- **Phase 3 — Social import (built 2026-08-05):** caption fetch + Haiku structuring (`app/ai.py`, `app/social.py`), link-card fallback, paste-anything box (`POST /api/recipes/structure`), and an AI fallback for web pages with no JSON-LD. Model `claude-haiku-4-5` ($1/$5 per Mtok) with **structured outputs** — the response is schema-constrained, so there is no fence-stripping or best-effort JSON parsing. Monthly budget cap in `app/usage.py` (Supabase `ai_usage_events`, fails open when unconfigured). **yt-dlp fallback skipped:** TikTok oEmbed plus og: tags cover the caption, and yt-dlp is heavy on serverless while facing the same datacenter-IP blocks. Revisit only if captions stop arriving.
- **Phase 4a — Planner (built 2026-08-05):** week view starting Sunday (the week's shopping happens on the weekend, so a plan and the list it feeds cover the same span), assign a recipe to a day and slot through a bottom-sheet picker, remove entries, navigate weeks. Storage mirrors recipes exactly: `lib/plan.js` over localStorage signed out and the `meal_plan` table signed in, with a one-time upload on sign-in that must run *after* the recipe upload, since `recipe_id` is a foreign key. Dates are handled in local time throughout (`lib/dates.js`) because `plan_date` is a zoneless Postgres `date` and `toISOString()` would shift evening assignments a day back.
- **Phase 4b — Shopping list (built 2026-08-05):** the week's planned recipes merged into a checklist grouped by aisle. **The list is derived, never stored** — it recomputes from the plan on every render, so editing the plan updates it with no regenerate step. Only what cannot be derived is persisted in `shopping_items`: which lines are ticked (`kind='check'`, `name` holds the merge key) and hand-added items (`kind='manual'`). That `kind` column is new; re-run `supabase/schema.sql`. Parsing lives in `lib/ingredients.js` and handles mixed numbers, vulgar fractions, ranges, unit aliases and trailing prep notes, falling back to the verbatim line when it can't. Two deliberate limits: different units for the same item stay separate lines rather than being converted, and aisle mapping is a hand-written keyword list matched longest-first, so it will misfile things occasionally.
- **Phase 5 — Organization + polish:** search, tags, collections/favorites, offline caching of saved recipes, icon set, install prompt.

## Security notes

- `extract` endpoint fetches arbitrary user-supplied URLs → SSRF guard (public IPs only, http/https only, size cap, timeout) lives in `backend/app/extract.py`. Keep it on every new fetch path.
- Caption text is untrusted input to the AI structurer — wrap in `<user_input>` tags, injection defense in system prompt (vault-level rule).
- Pydantic models with Field constraints on all POST bodies; opaque client errors.

## Non-goals (for now)

Multi-user sharing/households, nutrition data, recipe scaling, discovery feed, native apps.
