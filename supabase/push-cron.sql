-- A2: the clock that fires timer alerts. Run in the Supabase SQL editor AFTER
-- schema.sql has been applied and the API has PUSH_FIRE_SECRET, VAPID_PRIVATE_KEY
-- and VAPID_SUBJECT set. NOT part of schema.sql: it holds a secret reference and
-- a URL that changes on release day.
--
-- The secret and the URL live in Supabase Vault, not in this file. Run these two
-- once with your own values (the same secret as PUSH_FIRE_SECRET on the API):
--
--   select vault.create_secret('<the same value as PUSH_FIRE_SECRET>', 'push_fire_secret');
--   select vault.create_secret('https://<api host>/api/push/fire', 'push_fire_url');
--
-- Until release day the URL is the staging API. On release day repoint it:
--
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'push_fire_url'),
--     'https://recipe-box-api-sage.vercel.app/api/push/fire');

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Does nothing unless a timer is due, so the every-ten-seconds schedule costs one
-- indexed lookup per tick and no HTTP call while nothing is waiting.
create or replace function public.fire_due_timers() returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  secret text;
  target text;
begin
  if not exists (
    select 1 from cook_timers where sent_at is null and ends_at <= now()
  ) then
    return;
  end if;

  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_fire_secret';
  select decrypted_secret into target from vault.decrypted_secrets where name = 'push_fire_url';
  if secret is null or target is null then
    return;
  end if;

  perform net.http_post(
    url := target,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 8000
  );
end;
$$;

-- Nothing outside the database may call it: it reads the vault.
revoke all on function public.fire_due_timers() from public, anon, authenticated;

select cron.schedule('fire-due-timers', '10 seconds', 'select public.fire_due_timers()');

-- Housekeeping, daily. A job that runs every ten seconds writes a log row each
-- time, which fills the free tier's 500 MB if nothing trims it. Old timer rows go
-- too: sent or abandoned, nothing needs them after a day.
select cron.schedule(
  'trim-push-housekeeping',
  '17 4 * * *',
  $$
    delete from cron.job_run_details where end_time < now() - interval '1 day';
    delete from net._http_response where created < now() - interval '1 day';
    delete from public.cook_timers where ends_at < now() - interval '1 day';
  $$
);
