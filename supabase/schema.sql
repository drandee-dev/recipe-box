-- Recipe Box schema (phase 2). Run in Supabase SQL editor.

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

alter table recipes enable row level security;
alter table meal_plan enable row level security;
alter table shopping_items enable row level security;

create policy "own recipes" on recipes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own meal plan" on meal_plan
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own shopping items" on shopping_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists recipes_user_idx on recipes (user_id, created_at desc);
create index if not exists meal_plan_user_date_idx on meal_plan (user_id, plan_date);
create index if not exists shopping_user_week_idx on shopping_items (user_id, week_start);
