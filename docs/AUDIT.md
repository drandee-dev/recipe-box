# Recipe Box — audit, 2026-08-07

Read of `backend/app/*`, `frontend/src/**`, `supabase/schema.sql`, `vite.config.js`
at commit `a4e2968`, after phase 9. Nothing here is on fire; the app is in good
shape and most of what follows is either cost exposure, a first-sign-in edge, or
work that was always going to come after the features.

Ordered by what it costs to leave alone. Item numbers are stable — quote them.

## 1. The two AI endpoints are anonymous and unmetered per caller — FIXED 2026-08-07

Fixed with the per-IP cap, not the session requirement. Twenty model calls per
address per hour, counted off `ai_usage_events` (which grew a nullable `ip_hash`
column, so the schema needs a re-run), rejected with a 429 and a `Retry-After`.
The check runs in `meter_caller` at the top of both handlers, before any fetch or
model call, so a blocked caller costs a Supabase read and nothing else.

The address is a salted SHA-256 rather than the address itself, read from
`x-real-ip` in preference to `x-forwarded-for` — the latter is client-settable,
and trusting it first would let a caller hand themselves a fresh empty bucket on
every request. `RATE_LIMIT_SALT` is a new optional environment variable.

Endpoints stay anonymous, so signed-out paste and the iOS Safari capture path are
untouched.


`POST /api/recipes/extract` and `POST /api/recipes/structure` (`app/main.py:65`,
`app/main.py:79`) take a body and call Haiku with no session, no origin check
that matters (CORS is a browser rule, not a server one) and no per-caller cap.
The only ceiling is `AI_MONTHLY_BUDGET_CENTS`, which defaults to 500 — so anyone
who finds the URL can spend the whole month's $5 in a loop, and every request is
also a Vercel invocation against a free-tier quota.

Extraction being anonymous was a deliberate call (it fetches a public URL and
keeps nothing), and that reasoning holds for the *design*. It doesn't cover
spend. Cheapest fix that keeps the current UX: a per-IP counter in the same
`ai_usage_events` table, capped at something like 20 imports an hour, rejected
with a 429. Requiring a session on `/structure` is the stricter option but it
breaks signed-out paste, which is a real path today.

## 2. Monthly spend is summed by downloading every event row — WITHDRAWN 2026-08-07

`month_spend_cents` (`app/usage.py:30`) selects `cents` for every row since the
first of the month and sums it in Python. Two problems: it grows linearly with
usage on a check that runs before *every* model call, and it inherits whatever
row cap PostgREST is configured with — if a cap applies, spend silently plateaus
and the budget stops tripping.

Replace with the aggregate: `select=cents.sum()` on the same filter. One row
back, exact, no cap to reason about.

**This was wrong, and shipping it broke the thing it was meant to improve.**
Supabase disables aggregate functions on the data API by default. PostgREST
answered `PGRST123`, and because this path fails open by design the only symptom
was that the monthly ceiling stopped being enforced. Nothing threw, imports kept
working, and it was found by reading function logs inside the one hour Hobby
retains them.

Reverted to summing the rows, which demonstrably works, now with an explicit
`limit` so that hitting a cap is logged rather than silent. The original concern
was theoretical: a personal box produces a few hundred events a month, and
Supabase does not set a row cap by default. If exactness at volume ever matters,
the answer is a Postgres function called over `/rpc/`, not the aggregate API.

**The real fix was making it observable.** `/api/health` now reports
`budget: {tracked, spent_cents, limit_cents}`, so "not enforcing" is a curl away
instead of a log hunt. `tracked: false` means the ceiling is not being applied,
whatever the cause. This is the same reasoning that already put `images` in that
endpoint, and the lesson is that a fail-open path needs a readout by default:
this class of bug is undetectable from the outside without one.

`backend/tests/test_usage.py` covers the arithmetic and, more importantly, that a
failed lookup reports as untracked rather than as zero spent.

## 3. First sign-in races the plan migration against the recipe migration — FIXED 2026-08-07

`App.jsx:232` awaits `migrateLocalRecipes`, and `App.jsx:284` awaits
`migrateLocalPlan` — in a *separate effect*, which starts in the same tick. The
comment at `App.jsx:264` says recipes migrate first because `meal_plan.recipe_id`
is a foreign key, but nothing actually sequences them.

When someone signs in with both local recipes and local plan entries, the plan
upsert can reach Postgres before the recipe upsert commits, and the FK rejects
it. `migrateLocalPlan` throws, the local key survives (so the data isn't lost and
the next load succeeds), but the week renders empty and the raw Postgres string
`insert or update on table "meal_plan" violates foreign key constraint …` goes
straight to the error strip through `readError`.

Fix: move the plan and shopping migration into the recipes effect after the
recipe migrate resolves, or gate it on a flag the first effect sets. While in
there, `readError` should not pass a Postgres constraint message through to the
UI.

## 4. Delete is one tap, with no confirm and no undo

`RecipeList.jsx:326`. The button sits in the open recipe's action row next to
Edit and View source, and it removes the recipe, its images and its plan entries
immediately. For an app whose entire value is captures that took effort to get
in, that's the wrong shape.

An undo strip for a few seconds is better than a confirm dialog here — the
delete already keeps everything it needs to put the row back, and a confirm on a
phone is one more tap on the common path. `editing` also isn't cleared if the
recipe being deleted is open in the editor.

## 5. Errors and statuses are never announced — PARTLY FIXED 2026-08-07

Only the offline banner has `role="status"` (`App.jsx:855`). The import error
strip (`App.jsx:969`), the editor's save error (`RecipeEditor.jsx:398`) and every
account message (`Account.jsx:428`) render as plain paragraphs, so a screen
reader says nothing when an import fails or a sign-in is rejected.

The editor case is worse than an a11y gap: Save lives in the sticky head, the
form is about 1300px tall, and the error renders at the very bottom. A failed
save can leave someone looking at an unchanged sheet with no visible reason. Put
`role="alert"` on all three, and move the editor's error into the head or scroll
it into view.

**Done:** `role="alert"` on the three `rb-error` strips and the editor's,
`role="status"` on both account messages, and the editor's error moved from the
foot of the form to the top so it sits with the Save that failed. **Left:** the
notice and saved-confirmation paragraphs (`rb-notice`, `rb-saved`) are still
silent, and nothing scrolls a long form back to a message it just rendered.

## 6. There are no tests — PARTLY FIXED 2026-08-07

No vitest, no pytest, no Playwright (`frontend/package.json:6` has three
scripts). mtg-web has a hermetic E2E suite; this repo has nothing, at nine phases
and ~7,900 lines.

The highest-value target is not E2E. `lib/ingredients.js` is 409 lines of pure
functions — mixed numbers, vulgar fractions, ranges, unit aliases, aisle
matching, variant grouping, merge keys — and it is the thing most likely to be
quietly wrong in a way nobody notices until the shopping list is short an
ingredient in a shop. `lib/tags.js` and `app/ai.py:infer_tags` are the same
shape. Node's built-in test runner over the lib files needs no new dependency.

**Done:** `npm test` in `frontend/`, 49 tests under `node --test`, no new
dependency and nothing added to the bundle. `ingredients.test.js` covers the
quantity forms, unit aliasing, the merge, aisle keyword precedence and variant
grouping; `tags.test.js` covers normalization, chip counts and search, and ends
by parsing `ALLOWED_TAGS` out of `backend/app/ai.py` to enforce the vocabulary
parity that was previously only a comment in two files.

**It immediately found a real bug — see 6a below.**

**Left:** `app/ai.py:infer_tags` has no Python-side tests (the keyword tagger,
`NAME_ONLY_TAGS` and `INCIDENTAL` are exactly the same shape of risk), and there
is still no test that exercises a component.

## 6a. Plural merge keys dropped the wrong letter — FOUND BY 6, FIXED 2026-08-07

`singular()` in `lib/ingredients.js` normalises words for the merge key, and its
`-es` rule was `/(ch|sh|s|x|z)es$/`. Nothing in that class matches the `o` in
`tomatoes`, so the word fell through to the generic "drop the trailing s" and
became `tomatoe` — a different key from `tomato`, and a different key from the
base `tomato` used for variant grouping.

The effect: a week planning one recipe calling for **3 tomatoes** and another
calling for **1 tomato** produced two separate shopping lines, 3 and 1, instead
of one line for 4. Same for potatoes. Both are among the most commonly bought
things in the shop, the list looked completely normal, and the only way to notice
was to be standing in the shop holding it.

Fixed by adding `o` to the class. It over-collapses words like `shoes`, which are
not ingredients and never displayed — the string is a merge key only.

This is the entire argument for item 6 in one bug: no exception, no console
error, no visual defect. It had been shipped since phase 4b.

## 7. Sign-up advertises an 8-character minimum it doesn't enforce — FIXED 2026-08-07

`MIN_PASSWORD` is 8 (`Account.jsx:28`), the sign-up placeholder says "At least 8
characters", and `savePassword` enforces it — but the submit button only checks
`!password` (`Account.jsx:415`), so a 6-character password goes to Supabase and
is accepted at its own default. Apply the same `length < MIN_PASSWORD` check to
the signup branch.

## 8. Two backend dependencies are installed and never imported — FIXED 2026-08-07

`pyjwt` and `supabase` are in both `requirements.txt` and `pyproject.toml`, and
nothing under `backend/app/` imports either — auth verifies over HTTP through
GoTrue, and usage and storage both use `httpx` directly. They're pure cold-start
weight on a function that already carries Pillow. Drop them from both lists.

(`uvicorn` is in `requirements.txt` only. That's correct — it's local dev, and
the "the lists must match" rule exists to catch the opposite direction — but the
comment in `pyproject.toml` reads as if it's symmetric.)

## 9. No dark mode

`index.css` has one palette. There's a `prefers-reduced-motion` block but no
`prefers-color-scheme`. This is a phone app used in a kitchen, often at night,
and the warmed-neutral token layer means the work is mostly picking dark values
for tokens that already exist rather than rewriting rules.

## 10. Shopping rows accumulate with nothing to prune them

Every ticked derived line writes a `kind='check'` row keyed to a week
(`App.jsx:696`), and nothing ever deletes them. Weeks pass, plans change, and the
orphans stay. The `kind` column means they can never resurface as phantom items,
so this is quota rather than correctness — but on a free tier it's a table that
only grows. A delete of `kind='check'` rows older than ~8 weeks on load, or a
Postgres cron, closes it.

## 11. A planned meal can't be moved

`Planner.jsx:149` offers remove only. Shifting Tuesday's dinner to Wednesday
means deleting it, reopening the picker on the other day, searching for the
recipe again. The rows already carry `plan_date` and `slot`, so this is an update
and a small piece of UI, not new storage.

## 12. Taking a photo with the device still isn't possible

The stated next step at `docs/SPEC.md:112`. Recipes written by hand can only get
a photo by pasting a link to one that's already online, which for a recipe out of
a family notebook means there is no photo. Needs an upload endpoint alongside
`POST /api/recipes/image` — same auth, same resize, same bucket, bytes in the
request instead of a URL to fetch.

## 13. The SSRF guard resolves the host separately from the fetch

`_assert_public_host` (`app/extract.py:32`) calls `getaddrinfo`, then httpx
resolves the name again independently. A DNS record that returns a public address
to the first lookup and a private one to the second gets through both the
pre-check and the post-redirect re-check.

Listed for completeness, not urgency: it needs an attacker-controlled domain
aimed at a serverless function with nothing interesting on its loopback, and the
real fix (resolve once, connect to the pinned IP, carry the Host header) is a
custom transport. Worth knowing it's a known hole rather than a covered one.

---

# Part two — browser-aware rendering review

Reviewed against the browser-pipeline principles: cheap first screen, a real LCP
candidate, non-blocking parse, predictable CSS, stable layout, compositor-only
motion, JavaScript off the critical visual path.

Measured against the actual production build in `frontend/dist` (JS 484 KB, CSS
21.6 KB, fonts 91 KB across four files), not the dev server.

## Already right, so nobody undoes it

Worth stating plainly, because several of these are things the audit would
otherwise look like it's asking for:

- **Motion is compositor-only.** Every transition and keyframe in `index.css`
  touches `transform` or `opacity` and nothing else (`index.css:1315`,
  `:1321`, `:1706`, `:1761`). No animated `height`, `top` or `box-shadow`
  anywhere. `prefers-reduced-motion` is honoured in two places.
- **No layout shift from media.** Every image goes through `RecipeThumb`, which
  sets explicit `width`/`height` (`RecipeThumb.jsx:49`) inside a CSS
  `aspect-ratio` box, and renders a fallback element rather than leaving a gap.
  The `image_blur` data URI is a proper LQIP.
- **Responsive sources are already correct.** `thumbSources`
  (`lib/images.js:33`) hands the browser `320w`/`960w` with `sizes` set to the
  rendered box, so a 128px card on a phone stops pulling the 960px copy. First
  two cards are `eager` + `fetchpriority="high"`, the rest lazy
  (`RecipeThumb.jsx:52`).
- **No third-party scripts at all.** Nothing in the head, no analytics, no tag
  manager, no widgets. This is the single biggest thing most sites get wrong and
  this app simply doesn't have the problem.
- **The script tag is a module**, so it's deferred by default and doesn't block
  parsing, and CSS ships as a real stylesheet link rather than injected by JS.
- **Long lists don't need virtualising yet** and shouldn't be. A personal recipe
  box is dozens to low hundreds of rows with lazy images below the fold. Revisit
  past roughly a thousand.

## 14. The first paint is a blank shell, and the LCP is four hops deep

`dist/index.html` ships `<div id="root"></div>` and nothing else. Everything —
header, import bar, the list, the LCP image — waits on 484 KB of JavaScript.
Then the chain continues: `getSession()` resolves, the recipes query goes to
Supabase, React renders, and only *then* does the browser learn the URL of the
photo that is going to be the LCP element. The image can't be preloaded because
its URL isn't knowable at build time, and `fetchpriority="high"` is being set on
an element that doesn't exist until three network round trips have completed.

This is the one item on the list with real upside, and the app already contains
the fix. `lib/cache.js` keeps a mirror of the recipe rows in localStorage for
every signed-in user, and today it is read *only when a cloud read fails*
(`cache.js:56`). Seed the initial state from it instead: `useState(() =>
readCache(...) || [])`, render the list on the first pass, and let the cloud read
correct it when it lands. The rows are already there, keyed per user, and the
same mirror is what the offline path trusts — so this is a change to *when* it
gets read, not to what it guarantees.

That turns a returning visit into HTML → JS → paint with real content and a real
image URL, and it makes the `fetchpriority` and eager-loading already in
`RecipeThumb` do the job they were written for.

## 15. One 484 KB chunk, with no code splitting

`dist/assets/index-BmJMn9RZ.js` is everything: React 19, the whole Supabase
client, and all eight components. At startup the only visible tab is Recipes, yet
`Account`, `RecipeEditor`, `Planner`, `ShoppingList` and `InstallPrompt` are all
statically imported at `App.jsx:11`.

**Measured 2026-08-07, and it says my advice above was wrong.** Splitting the
bundle by hand gives:

| Chunk | Raw | Gzip |
|---|---|---|
| `@supabase/supabase-js` | 218.4 kB | 57.0 kB |
| `react-dom` | 184.9 kB | 57.8 kB |
| all app code (8 components + libs) | ~72 kB | ~26 kB |

The app's own code is **15% of the bundle**. Lazy-loading `RecipeEditor` and
`Account`, which is what this item originally recommended, moves about 20 kB of
484 kB and is not worth a `Suspense` boundary. `react-dom` is a floor that only
changes by changing framework, which is not on the table for a React 19 app.

**The whole prize is Supabase, and it is deferrable rather than shrinkable.**
The client is only needed once auth resolves, and a signed-out session never
needs it at all. Combined with item 14 that becomes one change rather than two:
render from the localStorage mirror on the first pass, then dynamically
`import()` the Supabase client and reconcile. That takes roughly 220 kB off the
critical path instead of 20. Trimming realtime, which this app never uses, by
importing `@supabase/auth-js` and `@supabase/postgrest-js` directly is a further
option once the deferral is in place.

Do items 14 and 15 together, and measure again rather than trusting this table
to still be true.

## 16. The fonts aren't preloaded, so the whole list reflows once

Four `@font-face` blocks at `index.css:5`, all `font-display: swap`, 91 KB total,
and no `<link rel="preload">` for any of them in `index.html`. The browser can't
discover them until it has downloaded and parsed the CSS, which means text paints
in the fallback and then swaps — reflowing every card in the list. The
`vite.config.js` comment at line 16 already identifies this exact reflow as the
reason fonts are precached, but precaching only helps the *second* visit.

Preload the two faces used above the fold (`Satoshi-Regular`, and
`ClashDisplay-Semibold` for the heading) with `<link rel="preload" as="font"
type="font/woff2" crossorigin>`. Leave Medium and Bold to be discovered normally.
Preloading all four would spend 91 KB of first-visit bandwidth against a first
screen that uses about 40 KB of it.

## 17. Mirrored photos are stored as JPEG only

`_encode` saves `format="JPEG"` at quality 82/80 (`app/images.py:105`), so every
photo we own — the whole point of phase 7 — is in the heaviest format of the
three the browser will take. Pillow writes WebP with no new dependency, and at
equivalent visual quality it lands roughly a quarter to a third smaller. AVIF
needs `pillow-avif-plugin`, which given how phase 7's Pillow deploy went is not a
dependency to add casually.

The storage path is content-addressed by recipe id, so this is a format change
plus the file extension, and `isMirrored` (`lib/images.js:19`) keys off the
bucket path rather than the extension, so nothing downstream cares. Existing
JPEGs can stay; the backfill only touches recipes that aren't mirrored yet.

## 18. The list area is blank while loading, rather than shaped like a list

`RecipeList.jsx:159` renders the empty state only when `!loading`, so during the
load there is nothing at all where the list will be. It doesn't cause a shift —
the list is the last thing on the page and nothing sits below it to be pushed —
but it does mean the first screen is a header, an import bar, and a void.

If item 14 is done this mostly solves itself, since the mirror gives real rows to
render. If it isn't, a few skeleton cards at the height of a real card
(`aspect-ratio` box plus two text bars) are worth more than a spinner.

## 19. `will-change` is used nowhere, including on the two things that need it

No occurrences in `index.css`. That's the right default and better than the usual
mistake, but there are exactly two elements here that match the sanctioned use —
an element known to be about to animate:

- `.rb-pull` while `dragging` is true. Its `transform` is rewritten every frame
  from the touch handler (`App.jsx:805`) with the transition deliberately off.
- `.sheet` during its rise animation.

Scope it to the active state only (`.rb-pull-dragging { will-change: transform }`),
never the resting one. A permanent `will-change` on a persistent element is the
overuse the guidance warns about.

## 20. Speculation rules don't apply here, and that's fine

Listed only to close the question: this is a single-page PWA with three tabs and
no navigations to prefetch. `<script type="speculationrules">` has nothing to
point at. The equivalent idea — preparing the next view before it's asked for —
is item 15's lazy chunks, which can be prefetched on tab hover if the split ever
shows a delay.

---

# Part three — form validation and input trust

Reviewed against the defence-in-depth form guide: client validation, XSS
sanitisation, server-side re-validation, CORS.

## What the guide asks for that this app doesn't need

Said plainly up front, because following the template as written would make the
app worse rather than safer.

- **The `xss` package has nothing to sanitise.** There is no
  `dangerouslySetInnerHTML` and no `innerHTML` anywhere in `frontend/src`, so
  every scraped title, model-written instruction and pasted caption is escaped by
  JSX on the way to the DOM. Running scraped text through an HTML sanitiser
  before storing it would mean storing a mangled version of a recipe (`Tom & Jerry's`
  becoming an entity soup) to defend against an injection route the app doesn't
  have. Sanitise on output, and React already does.
- **Zod would be a stack change, not a security fix.** This is JSX, not
  TypeScript, so the half of the guide's value that comes from `z.infer` deriving
  types isn't available. It also adds to a bundle that item 15 is trying to cut.
  The validation this app actually lacks is length caps, and `maxLength` on the
  inputs plus CHECK constraints in Postgres covers that at zero bundle cost.
- **The form schemas are for a different app.** Enquiry, newsletter, booking, UK
  phone numbers, a terms checkbox. Recipe Box collects an email and a password,
  and everything else it stores is a recipe the same person typed or imported for
  themselves. There's no PII intake path to harden.
- **The Next.js API routes don't apply.** The backend is FastAPI, and it already
  does what those examples do: Pydantic `BaseModel` with `Field` constraints on
  every POST body, structured errors, opaque messages, tracebacks logged server
  side (`app/main.py:32-43`).

What follows is the part that does apply.

## 21. A source link renders as an `href` with no protocol check — FIXED 2026-08-07

`RecipeList.jsx:319` renders `href={r.source_url}` as a "View source" link.
`source_url` is free text from the editor's Source link field
(`RecipeEditor.jsx:389`), which validates nothing.

The odd part is that the field directly above it does. `isImageLink`
(`RecipeEditor.jsx:45`) already exists, already checks for `http:`/`https:`, and
is already wired to `aria-invalid` and a hint on the photo field. The source
field just never got it. So `javascript:alert(1)` typed into Source link is
stored and rendered as a link.

React logs a warning on `javascript:` URLs and has been moving toward blocking
them outright, so this may well be inert in React 19 — but the framework being
the last line of defence for a field whose sibling is validated in the same
component is the wrong shape. Apply `isImageLink` to `source_url` too, rename it
to something honest like `isHttpLink`, and block save the same way.

Self-inflicted rather than cross-account, since RLS means you can only write your
own rows. That caps the severity; it doesn't make it correct.

## 22. Nothing caps the length of anything

No `maxLength` on any input in the app (zero matches across `frontend/src`), no
length checks in `handleEditorSave`, and no CHECK constraints in
`supabase/schema.sql` — `title` is bare `text`, `ingredients` and `instructions`
are bare `jsonb`.

This matters more here than in a typical form app because of who writes the rows.
Recipes never go through the FastAPI backend: the client writes them straight to
Postgres through PostgREST (`lib/store.js:93`). RLS checks *ownership* and
nothing checks *shape*. The guide's "re-validate server-side, never trust the
client" has no server to run on for this path — the database is the server, so
the constraints have to live there.

Two halves, both cheap:

- `maxLength` on the editor's title, description, servings, ingredient and step
  inputs, matching what the backend already enforces on the paste box (12,000
  chars, `main.py:37`).
- CHECK constraints in `schema.sql` on `length(title)`, `length(description)`,
  and `jsonb_array_length(ingredients)`. One migration, and it holds regardless of
  what the client does.

Signed out this is also a quota problem: recipes go to localStorage, and a
runaway row takes the ~5 MB budget with it, at which point `store.save` throws
and the capture is lost.

## 23. The JSON-LD path trusts whatever the page hands back

`parse_jsonld_recipe` (`app/extract.py:163`) reads `name`, `description`,
`recipeIngredient` and `recipeInstructions` off an arbitrary site's markup and
passes them through with no caps at all — no truncation on the title, no limit on
how many ingredient lines come back, no bound on total size. The only ceiling
anywhere on that path is the 3 MB page fetch.

Contrast the AI path, which is bounded twice over: input truncated to 12,000
chars (`ai.py:25`) and output capped by `MAX_TOKENS = 2000`. So the route with no
model in it is the loose one, which is the opposite of the intuition.

A site with broken markup — a `keywords` field holding a whole page, a recipe
node repeated a thousand times — produces a row that then has to render in a
list, sit in localStorage, and go through `buildShoppingList`. Truncate on the way
out of the parser: title and description to a few hundred chars, ingredients and
instructions to a sane count.

## 24. CORS always allows localhost, in production — FIXED 2026-08-07

`cors_origins()` (`app/config.py:6`) returns `DEFAULT_ORIGINS + extra`, and
`DEFAULT_ORIGINS` is the two localhost ports. They are unconditionally present in
the deployed allow-list, so the production API answers a browser running against
`http://localhost:5173`.

The practical impact is small — these endpoints carry no cookies and two of the
three need no session at all — but it's exactly the drift the guide's CORS
section is about, and it makes the anonymous-abuse story in item 1 slightly worse
by handing any local dev page a working origin.

Gate the defaults on an env flag so production ships only what
`RECIPE_CORS_ORIGINS` names. While in there: `allow_credentials=True`
(`main.py:27`) is doing nothing, since auth travels as a bearer token and not a
cookie, and `allow_methods=["*"]`/`allow_headers=["*"]` are wider than the three
POSTs and two headers actually used.

**This turned out to cost more than "slightly worse".** Every Vercel preview gets
a hostname of its own, so a static allow-list meant *no preview deployment could
ever call the API*: the browser's preflight came back 400 with no
`Access-Control-Allow-Origin`, `fetch` rejected, and every import, paste and
photo mirror failed as "Failed to fetch". The audit branch could not be tested
against its own backend, which is how this was found.

**Done:** localhost is added only when `VERCEL_ENV` is unset, so it is gone from
deployments; preview hostnames are matched by an anchored, account-qualified
regex (`DEFAULT_PREVIEW_ORIGIN_REGEX`, overridable via
`RECIPE_CORS_ORIGIN_REGEX`); credentials are no longer granted; methods and
headers are narrowed to what is used. An empty `RECIPE_CORS_ORIGINS` on a
deployment now logs a warning, since that variable is the only thing letting the
production site through. `backend/tests/test_cors.py` pins the allows and the
refusals, including a foreign Vercel account and the `…vercel.app.evil.com`
suffix that an unanchored pattern would have let through.

## 25. Cross-reference: the password minimum

The guide's "validate on the client *and* the server" is item 7 above — sign-up
advertises 8 characters, enforces none, and falls back to whatever Supabase's own
default is. Same fix, listed there.


---

# Part four — the Lazy Developer guides

Reviewed against the 12 live guides at thelazydeveloper.org/resources, two of
which (Form Validation & Security, Browser-Aware Web Design) are already covered
in parts two and three.

## Six of the twelve do not apply, and running them would be theatre

The **SEO & Analytics** track (4 guides: on-page SEO, crawlability, structured
data, GA4) and the **AEO / AI Search** track (2 live: AEO foundations, inspecting
AI search) both optimise for being found, read and cited by search engines and
answer engines.

Recipe Box has no public surface to find. It is a `display: standalone` PWA whose
every screen sits behind a sign-in, its content is recipes the user imported for
themselves, and there is no marketing page, no article, no pricing, no
organisation entity. Adding JSON-LD, a sitemap or a crawlability pass would be
markup nothing will ever request. The GA4 guide is additionally Next.js-specific
and the app has no analytics at all, which is a deliberate position rather than
an oversight.

Worth revisiting only if a public landing page is ever added.

## 26. The image endpoint checks who is calling, never what they are touching — FIXED 2026-08-07

`recipe_is_owned` in `images.py` runs the suggested query before the mirror and
the endpoint answers 422 when it comes back empty. It fails closed: a lookup that
could not complete returns False and the mirror is skipped, which is cheap on a
path the client already retries on a later load.


From **Authorization & IDOR**. `POST /api/recipes/image` verifies the caller's
session properly and derives `user_id` from the token rather than the body
(`main.py:123`), which is exactly the pattern that guide asks for, and the two
things it writes land under that verified id. So far so good.

What is missing is the second gate. `recipe_id` comes off the request body and is
never checked against the caller's recipes. There is no cross-user write — the
storage path is `{verified_user_id}/{recipe_id}`, so a caller can only write into
their own folder — but there is also nothing tying a mirror to a recipe that
exists. An authenticated caller can post arbitrary UUIDs with arbitrary image
URLs and have the backend fetch and store each one, indefinitely, in our bucket.
Sign-up is open, so the cost of getting an account is an email address, and the
free tier's storage is the thing being spent.

The client-side cleanup makes it worse rather than better: `store.remove` deletes
`{user_id}/{recipe_id}-lg.jpg` and `-sm.jpg` for recipes the app knows about, so
objects filed under a `recipe_id` that never was a recipe are unreachable by that
path and are never collected.

Fix is one query before the mirror, using the service-role key the backend
already holds: `recipes?id=eq.{recipe_id}&user_id=eq.{user_id}&select=id`, and a
422 when it comes back empty. That is the same shape and roughly the same cost as
the GoTrue round trip already on this path.

## 27. A shared secret cannot fix item 1, and the budget makes it worse — RESOLVED 2026-08-07

The sub-decision this item asks for was taken: the budget check **keeps failing
open**, and so does the new rate lookup. The reasoning that made failing open
uncomfortable was that it left a public endpoint with no ceiling at all during a
Supabase outage. With item 1 fixed there are two ceilings and they cover each
other — an outage that removes the monthly one still leaves an endpoint no single
caller can loop on, and `/api/health` reports `budget.tracked: false` so the
untracked state is visible from outside. Failing closed was rejected because it
means a Supabase blip stops the owner importing recipes.


From **Securing Endpoints**. That guide's headline pattern for an endpoint with
side effects is a shared secret, constant-time compared, failing closed. Written
down here so nobody reaches for it: **it does not work for item 1.** The only
caller of `/api/recipes/extract` and `/api/recipes/structure` is a public SPA, so
any secret it could present is in the bundle every visitor downloads, which the
**Environment Variables & API Keys** guide is explicitly about. A secret shipped
to the browser is a secret in the same sense as a doormat key.

That leaves the two options item 1 already names: a per-IP cap, or requiring a
session and giving up signed-out paste.

The guide's fail-closed principle does expose something new, though. `usage.py`
fails **open** by design: an unreachable or misconfigured Supabase returns `None`
and `_structure` proceeds without a budget check (`ai.py`, "both usage calls fail
open so a Supabase outage never blocks an import"). That is defensible on its own
and the reasoning is sound. Stacked on an endpoint anyone can call, it means a
Supabase outage turns a $5 monthly ceiling into no ceiling, on a public endpoint,
silently. Whichever fix item 1 gets should also decide whether the budget check
is still allowed to fail open once the endpoint is no longer anonymous.

Passes worth recording from the same guide: identity is never read from a request
body, no endpoint constructs email headers (Supabase sends all mail), and every
handler returns an opaque message while logging the traceback server-side.

## 28. Secrets hygiene is in good shape, with two small gaps — FIXED 2026-08-07

Both done. `.gitignore` is now `.env*` plus `!.env.example`, verified with
`git check-ignore` against `.env.production` and friends, and both example files
are still tracked. `SUPABASE_JWT_SECRET` is gone from `backend/.env.example`,
replaced by a comment saying why there isn't one.


From **Environment Variables & API Keys**. Checked and clean: no secret wears a
`VITE_` prefix (the three that exist are the API base URL, the Supabase URL and
the anon key, all publishable by design), no `.env` has ever been committed on
any branch, both `.env.example` files are keyless, and no secret-shaped literal
appears anywhere in tracked source. `SUPABASE_SERVICE_ROLE_KEY` is read only by
`images.py` and `usage.py`, both server-side.

Two things to tidy:

- `.gitignore` lists `.env` and `.env.local` specifically. `.env.production`,
  `.env.development` and anything else in that family are **not** ignored. The
  guide's pattern is `.env*` plus `!.env.example`, which fails safe instead of
  enumerating.
- `backend/.env.example` documents `SUPABASE_JWT_SECRET`, which nothing reads.
  `auth.py` verifies tokens by asking GoTrue rather than checking a signature
  locally, and deliberately so. A documented variable that no code consumes is an
  invitation to paste a real secret somewhere it isn't needed.
