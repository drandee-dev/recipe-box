-- Recipe Box schema. Run in the Supabase SQL editor.
-- Safe to re-run: every statement is guarded, so applying it again is a no-op
-- on what already exists and creates whatever is new.

create table if not exists recipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  source_url text,
  source_type text not null default 'manual'
    check (source_type in ('web', 'tiktok', 'instagram', 'manual')),
  image_url text,
  description text,
  ingredients jsonb not null default '[]',   -- [{raw, item, qty, unit}]
  instructions jsonb not null default '[]',  -- [string]
  prep_min int,
  cook_min int,
  total_min int,
  servings text,
  tags text[] not null default '{}',
  favorite boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists meal_plan (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  recipe_id uuid not null references recipes (id) on delete cascade,
  plan_date date not null,
  slot text not null default 'dinner'
    check (slot in ('breakfast', 'lunch', 'dinner', 'snack')),
  created_at timestamptz not null default now()
);

create table if not exists shopping_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  recipe_id uuid references recipes (id) on delete set null,
  week_start date,
  name text not null,
  quantity text,
  checked boolean not null default false,
  created_at timestamptz not null default now()
);

-- Phase 4b. The shopping list is derived from the plan rather than stored, so a
-- row here is one of two things: an item you added by hand, or a checkmark
-- against a derived line. Without this flag the two are indistinguishable as
-- soon as a plan change removes the line a check belonged to, and the orphaned
-- check reappears as a phantom manual item.
alter table shopping_items add column if not exists kind text not null default 'manual';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shopping_items_kind_check') then
    alter table shopping_items
      add constraint shopping_items_kind_check check (kind in ('manual', 'check'));
  end if;
end $$;

-- Phase 7: the mirrored photo. image_url holds the 960px copy once we own the
-- bytes (it still holds the origin's URL until then, which is what tells the
-- backfill what is left to do), image_thumb_url the 320px one the card actually
-- renders, and image_blur a ~20px JPEG inlined as a data URI so the image box
-- has something in it while the photo loads.
alter table recipes add column if not exists image_thumb_url text;
alter table recipes add column if not exists image_blur text;

-- Public read, because these are <img> sources: a signed URL would expire and
-- put us back where we started, and the service worker's CacheFirst rule can
-- only keep a plain one. The path is two UUIDs, so nothing is guessable.
insert into storage.buckets (id, name, public)
values ('recipe-images', 'recipe-images', true)
on conflict (id) do update set public = true;

-- Uploads come from the backend with the service role key, which bypasses RLS,
-- so there is deliberately no insert policy: the client cannot write here.
-- Delete is the client's job — a recipe deleted in the app removes its own two
-- objects, and on the free tier orphans are the thing that eventually costs
-- something. foldername(name)[1] is the user id the backend filed it under.
drop policy if exists "own recipe images" on storage.objects;
create policy "own recipe images" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'recipe-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Phase 3: AI spend log. Written by the backend with the service role key, so
-- RLS stays on with no policy — clients get nothing.
create table if not exists ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  cents numeric not null default 0,
  model text not null,
  ip_hash text,
  created_at timestamptz not null default now()
);

alter table ai_usage_events enable row level security;

-- One row per model call serves two jobs: the monthly spend ledger, and the
-- per-caller hourly cap on the two anonymous AI endpoints. `ip_hash` is a salted
-- SHA-256 of the connecting address (app/usage.py), never the address itself,
-- and is null for any call that did not arrive over HTTP. Added by `alter` as
-- well as in the create above, since the table predates the column.
alter table ai_usage_events add column if not exists ip_hash text;

create index if not exists ai_usage_created_idx on ai_usage_events (created_at desc);
create index if not exists ai_usage_ip_idx on ai_usage_events (ip_hash, created_at desc);

alter table recipes enable row level security;
alter table meal_plan enable row level security;
alter table shopping_items enable row level security;

-- Postgres has no "create policy if not exists", so drop first or a re-run
-- aborts the whole script and rolls back everything above it.
drop policy if exists "own recipes" on recipes;
create policy "own recipes" on recipes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own meal plan" on meal_plan;
create policy "own meal plan" on meal_plan
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own shopping items" on shopping_items;
create policy "own shopping items" on shopping_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists recipes_user_idx on recipes (user_id, created_at desc);
create index if not exists meal_plan_user_date_idx on meal_plan (user_id, plan_date);
create index if not exists shopping_user_week_idx on shopping_items (user_id, week_start);

-- 1.0.1: ideas and bug reports sent from the app (components/News.jsx).
-- Insert-only from the client: a signed-in user can file a report under their
-- own id, and there is deliberately no select, update or delete policy, so
-- nobody reads reports through the API, their own included. Andres reads them
-- in the Supabase table editor, which bypasses RLS. The checks cap what one
-- insert can store, since the client is the only thing in front of this table.
create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('idea', 'bug')),
  body text not null check (char_length(body) between 1 and 2000),
  app_version text check (char_length(app_version) <= 40),
  user_agent text check (char_length(user_agent) <= 400),
  created_at timestamptz not null default now()
);

alter table feedback enable row level security;

drop policy if exists "file own feedback" on feedback;
create policy "file own feedback" on feedback
  for insert to authenticated
  with check (auth.uid() = user_id);

create index if not exists feedback_created_idx on feedback (created_at desc);

-- A2: timer alerts on a locked phone. Additive only (new tables nothing else
-- reads), so the live app is unaffected until it is released.
--
-- push_subscriptions: where to send a user's alerts. One row per installed app
-- per user; the endpoint is the push service's address for that phone.
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null check (char_length(endpoint) <= 2000),
  -- (host allow-list is added just below as push_endpoint_is_push_service)
  p256dh text not null check (char_length(p256dh) <= 200),
  auth text not null check (char_length(auth) <= 100),
  user_agent text check (char_length(user_agent) <= 400),
  created_at timestamptz not null default now(),
  unique (user_id, endpoint)
);

alter table push_subscriptions enable row level security;

drop policy if exists "own push subscriptions" on push_subscriptions;
create policy "own push subscriptions" on push_subscriptions
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- cook_timers: a running timer, mirrored so a server can fire it. The client
-- inserts on start and deletes on stop or when it rings in the page (so the page
-- and the push never both alert). `client_id` is the app's own timer id;
-- `sent_at` is the server's claim, set once per row (app/push.py).
create table if not exists cook_timers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id text not null check (char_length(client_id) <= 80),
  ends_at timestamptz not null,
  label text check (char_length(label) <= 60),
  recipe_title text check (char_length(recipe_title) <= 200),
  open_url text check (char_length(open_url) <= 500),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, client_id)
);

alter table cook_timers enable row level security;

drop policy if exists "own cook timers" on cook_timers;
create policy "own cook timers" on cook_timers
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- What the cron job scans every few seconds: only unsent rows, by due time.
create index if not exists cook_timers_due_idx on cook_timers (ends_at) where sent_at is null;

-- A2 hardening (review): the API POSTs to whatever endpoint a user stored, and
-- sign-in is open to anyone, so the table only accepts addresses of real push
-- services (the API checks the same list, app/push.py allowed_endpoint), and one
-- user cannot hold unbounded rows that crowd everyone else's alerts out of the
-- cron batch. Added as alters so a project that already has the tables gets
-- them. Safe to add outright: the tables were empty when this was written.
alter table push_subscriptions drop constraint if exists push_endpoint_is_push_service;
alter table push_subscriptions add constraint push_endpoint_is_push_service check (
  endpoint ~* '^https://(web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.(push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com))(/|\?|$)'
);

create or replace function cap_push_rows() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_table_name = 'push_subscriptions'
     and (select count(*) from public.push_subscriptions where user_id = new.user_id) >= 10 then
    raise exception 'too many push subscriptions';
  end if;
  if tg_table_name = 'cook_timers'
     and (select count(*) from public.cook_timers where user_id = new.user_id and sent_at is null) >= 20 then
    raise exception 'too many timers';
  end if;
  return new;
end;
$$;

drop trigger if exists push_subscriptions_cap on push_subscriptions;
create trigger push_subscriptions_cap before insert on push_subscriptions
  for each row execute function cap_push_rows();

drop trigger if exists cook_timers_cap on cook_timers;
create trigger cook_timers_cap before insert on cook_timers
  for each row execute function cap_push_rows();

-- A2 repeats: a finished timer is sent again every 30 seconds, up to 6 times in
-- all, until the app deletes the row (opening it or dismissing the timer). The
-- count is what the server's claim compares against, so two overlapping runs
-- cannot both send the same one. Numbers match app/push.py REPEAT_SECONDS and
-- MAX_NOTIFICATIONS, and supabase/push-cron.sql.
alter table cook_timers add column if not exists notify_count integer not null default 0;

-- Rows the server already sent before this column existed have a count of 0 and
-- would look like unsent first sends. Close them out so none is sent again.
update cook_timers set notify_count = 6 where sent_at is not null and notify_count = 0;

create index if not exists cook_timers_active_idx on cook_timers (ends_at) where notify_count < 6;

-- Pass C (planner and shopping list). Additive only: a nullable column the live
-- app never selects, and a new table it never reads.
--
-- meal_plan.servings: how many servings this planned meal is for. Null means "as
-- the recipe says", which is every row that exists today, so nothing changes for
-- them. It scales the quantities the shopping list gathers from this meal and
-- touches nothing else: the list's merge keys (name|dimension) are unchanged, so
-- the ticks stored in shopping_items keep meaning what they meant.
alter table meal_plan add column if not exists servings smallint;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'meal_plan_servings_check') then
    alter table meal_plan
      add constraint meal_plan_servings_check check (servings is null or servings between 1 and 500);
  end if;
end $$;

-- shopping_prefs: one row per person. Display-only choices about the list, kept
-- apart from shopping_items on purpose: they decide where a line is shown and
-- whether it is collapsed, never what the line's merge key is.
--   staples      normalised item names kept in a collapsed "Staples" section
--   aisle_map    normalised item name -> the aisle you moved it to
--   aisle_order  your shop's aisle order (empty = the built-in order)
-- The size checks stop a bad client filling the free tier through one row.
create table if not exists shopping_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  staples text[] not null default '{}',
  aisle_map jsonb not null default '{}',
  aisle_order text[] not null default '{}',
  updated_at timestamptz not null default now(),
  constraint shopping_prefs_size check (
    cardinality(staples) <= 400
    and cardinality(aisle_order) <= 20
    and jsonb_typeof(aisle_map) = 'object'
    and pg_column_size(staples) < 32768
    and pg_column_size(aisle_map) < 65536
  )
);

alter table shopping_prefs enable row level security;

drop policy if exists "own shopping prefs" on shopping_prefs;
create policy "own shopping prefs" on shopping_prefs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Notes and the cooked log. Additive only: a nullable column the live app never
-- selects, and a new table it never reads.
--
-- recipes.notes: what you learned cooking it ("used half the sugar"). Searchable
-- from the client; the steps deliberately are not (SPEC 5a). Capped so one field
-- cannot fill the free tier.
alter table recipes add column if not exists notes text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'recipes_notes_check') then
    alter table recipes
      add constraint recipes_notes_check check (notes is null or char_length(notes) <= 4000);
  end if;
end $$;

-- cook_log: one dated row per time a recipe was cooked, rather than a counter.
-- The count, the last date and the "Recently cooked" and "Most cooked" sorts all
-- come from the same rows, and a mistaken tap is one row deleted. Deleting a
-- recipe deletes its log.
create table if not exists cook_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  recipe_id uuid not null references recipes (id) on delete cascade,
  cooked_at timestamptz not null default now()
);

alter table cook_log enable row level security;

drop policy if exists "own cook log" on cook_log;
create policy "own cook log" on cook_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists cook_log_user_recipe_idx on cook_log (user_id, recipe_id, cooked_at desc);

-- Leftovers in the planner. Additive only: a boolean the live app never selects
-- or writes. It defaults to false, which is what every existing row and every row
-- the live app inserts means: a meal that has to be bought for. A planned meal
-- flagged true is eaten from what was cooked earlier, so the shopping list leaves
-- it out.
alter table meal_plan add column if not exists leftover boolean not null default false;
