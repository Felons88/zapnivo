-- Migration 0089 — in-database schedulers for frequent queue drains.
--
-- Vercel Hobby rejects sub-daily cron expressions, so the vercel.json entries
-- are daily backstops only. The real frequent drains run here: pg_cron ticks
-- pg_net HTTP calls at the existing /api/cron/* routes, which keep their own
-- auth (CRON_SECRET bearer), audit (cron_runs), and pause controls.
--
-- worker_secrets holds ONLY the cron bearer needed to authenticate those
-- calls. Its value is inserted out-of-band via the service role — never
-- committed. RLS enabled with no policies: service-role only, like the other
-- system tables. If the row is missing the jobs no-op (the WHERE exists
-- guard), so this migration is safe to apply before the secret is seeded.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists worker_secrets (
  key text primary key check (key ~ '^[a-z0-9][a-z0-9_.-]{0,80}$'),
  value text not null,
  updated_at timestamptz not null default now()
);
alter table worker_secrets enable row level security;

-- Every 5 minutes: push/SMS queue drain (retries + future-due reminders).
select cron.schedule(
  'zapnivo-notifications-drain',
  '*/5 * * * *',
  $job$
    select net.http_get(
      url := 'https://www.zapnivo.com/api/cron/notifications',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select value from public.worker_secrets where key = 'cron_secret')
      ),
      timeout_milliseconds := 30000
    )
    where exists (select 1 from public.worker_secrets where key = 'cron_secret')
  $job$
);

-- Every 5 minutes: inbound email queue drain (backstop to the webhook's own
-- after() kick — catches jobs enqueued while a deployment was cut short).
select cron.schedule(
  'zapnivo-inbound-drain',
  '*/5 * * * *',
  $job$
    select net.http_get(
      url := 'https://www.zapnivo.com/api/cron/inbound',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select value from public.worker_secrets where key = 'cron_secret')
      ),
      timeout_milliseconds := 30000
    )
    where exists (select 1 from public.worker_secrets where key = 'cron_secret')
  $job$
);
