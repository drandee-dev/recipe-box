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
