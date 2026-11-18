-- Migration 0090 — centralized customer notification engine.
--
--   notifications            — the persistent in-app record the notification
--                              center reads. One row per customer-facing
--                              notification; dedupe_key makes re-emission safe.
--   notification_events      — durable outbox: a mutation emits an event row;
--                              the sweep (in-band + pg_cron drain) renders and
--                              fans out. Retries with backoff → 'dead'.
--   notification_deliveries  — per-channel ledger (in_app/push/email/sms) per
--                              notification: sent/failed/skipped + detail.
--   customer_notification_prefs — per-customer optional-category toggles and
--                              quiet hours. Essential categories (security,
--                              payment, account) are not suppressible — that is
--                              enforced in src/lib/notify.ts, not here.
--   notification_templates   — editable copy per kind; the code registry in
--                              src/lib/notify.ts is the fallback when no row.

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  category text not null check (category in ('account','security','payment','rental','support','offer')),
  kind text not null,
  title text not null check (char_length(title) between 1 and 160),
  body text not null check (char_length(body) between 1 and 1000),
  data jsonb not null default '{}'::jsonb,          -- deep link + safe display vars (never secrets)
  read_at timestamptz,
  created_at timestamptz not null default now(),
  dedupe_key text unique
);
create index if not exists notifications_profile_idx on notifications (profile_id, created_at desc);
create index if not exists notifications_unread_idx on notifications (profile_id) where read_at is null;

create table if not exists notification_events (
  id bigint generated always as identity primary key,
  status text not null default 'queued' check (status in ('queued','done','failed','dead')),
  profile_id uuid not null references profiles(id) on delete cascade,
  kind text not null,
  vars jsonb not null default '{}'::jsonb,
  actor text,                                       -- 'staff:<id>' | 'admin:<id>' | 'system' | 'webhook'
  correlation_id text,                              -- request/rental/ticket correlation id
  dedupe_key text unique,
  attempts int not null default 0,
  due_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists notification_events_due_idx on notification_events (status, due_at) where status = 'queued';

create table if not exists notification_deliveries (
  id bigint generated always as identity primary key,
  notification_id uuid not null references notifications(id) on delete cascade,
  channel text not null check (channel in ('in_app','push','email','sms')),
  status text not null check (status in ('sent','failed','skipped','deferred')),
  detail text,
  created_at timestamptz not null default now(),
  unique (notification_id, channel)
);
create index if not exists notification_deliveries_status_idx on notification_deliveries (status, created_at desc);

create table if not exists customer_notification_prefs (
  profile_id uuid primary key references profiles(id) on delete cascade,
  offers boolean not null default true,
  product_updates boolean not null default true,
  rental_reminders boolean not null default true,
  support_updates boolean not null default true,
  rewards boolean not null default true,
  quiet_start smallint check (quiet_start between 0 and 23),   -- local quiet window start hour (push/email deferred; in-app still records)
  quiet_end smallint check (quiet_end between 0 and 23),
  timezone text not null default 'America/Chicago',
  updated_at timestamptz not null default now()
);

create table if not exists notification_templates (
  kind text primary key check (kind ~ '^[a-z0-9_]{2,60}$'),
  category text not null check (category in ('account','security','payment','rental','support','offer')),
  title text not null check (char_length(title) between 1 and 160),
  body text not null check (char_length(body) between 1 and 1000),
  channels text[] not null default '{in_app,push}',
  essential boolean not null default false,          -- can't be opted out or quieted
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

-- RLS: customers read/update ONLY their own notification rows and prefs.
-- events/deliveries/templates are service-role only (deny-all like other
-- system tables — the portal reads them through the service client).
alter table notifications enable row level security;
create policy notifications_select_own on notifications for select using (auth.uid() = profile_id);
create policy notifications_update_own on notifications for update
  using (auth.uid() = profile_id) with check (auth.uid() = profile_id);

alter table customer_notification_prefs enable row level security;
create policy cnp_select_own on customer_notification_prefs for select using (auth.uid() = profile_id);
create policy cnp_insert_own on customer_notification_prefs for insert with check (auth.uid() = profile_id);
create policy cnp_update_own on customer_notification_prefs for update
  using (auth.uid() = profile_id) with check (auth.uid() = profile_id);

alter table notification_events enable row level security;
alter table notification_deliveries enable row level security;
alter table notification_templates enable row level security;

-- Realtime: the app subscribes to inserts for the live notification feed/badge.
alter publication supabase_realtime add table notifications;
