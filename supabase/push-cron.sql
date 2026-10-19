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
-- pg_catalog first, and every other object schema-qualified below, so nothing a
-- user could create in public can shadow what a security definer function calls.
set search_path = pg_catalog
as $$
declare
  secret text;
  target text;
begin
  -- The same question app/push.py asks (REPEAT_SECONDS 30, MAX_NOTIFICATIONS 6):
  -- finished, and either never sent or last sent long enough ago to send again.
  if not exists (
    select 1 from public.cook_timers
    where ends_at <= now()
      and notify_count < 6
      and (sent_at is null or sent_at <= now() - interval '30 seconds')
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

-- Release announcement: asks the PRODUCTION API every ten minutes whether this
-- release has been announced (app/release.py). Almost every call does nothing:
-- the API answers "already_sent" or "waiting" and sends once, when the live
-- frontend serves the version in release.py. Run once, with the production API
-- host (never staging, or staging would announce too):
--
--   select vault.create_secret('https://recipe-box-api-sage.vercel.app/api/push/announce', 'push_announce_url');
--
-- It reuses push_fire_secret. The API also needs RELEASE_APP_ORIGIN (the
-- production frontend's origin, a plain config value) or it announces nothing.
create or replace function public.announce_release() returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  secret text;
  target text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_fire_secret';
  select decrypted_secret into target from vault.decrypted_secrets where name = 'push_announce_url';
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

revoke all on function public.announce_release() from public, anon, authenticated;

select cron.schedule('announce-release', '*/10 * * * *', 'select public.announce_release()');

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
