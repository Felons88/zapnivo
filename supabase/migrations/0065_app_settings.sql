-- Migration 0065 — Phase 4.1: nonsecret application settings (system_app_settings).
--
--   system_app_settings — whitelisted key/value application settings managed
--                         from system.zapnivo.com (/system/settings/app). Values
--                         are NONSECRET configuration only: the code-side
--                         registry in src/lib/system/app-settings.ts is the
--                         allowlist — arbitrary keys can never be written, and
--                         secret-looking keys/values are rejected before any
--                         DB call. risk='high' rows additionally require a
--                         fresh step-up elevation (system_elevations).
--
-- RLS: enabled with NO policies — the service role (src/lib/system/*) is the
-- only writer/reader, matching the append-only system tables convention. There
-- is deliberately no staff select policy: settings may inform security
-- decisions and are not needed on customer-facing surfaces.

create table if not exists system_app_settings (
  key text primary key check (key ~ '^[a-z0-9][a-z0-9_.-]{0,80}$'),
  environment text not null default 'production',
  value jsonb not null,
  risk text not null default 'low' check (risk in ('low','high')),
  description text not null default '',
  updated_by uuid,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists system_app_settings_updated_idx on system_app_settings (updated_at desc);

alter table system_app_settings enable row level security;
-- No policies: deny-all for anon/authenticated; service role bypasses RLS.
