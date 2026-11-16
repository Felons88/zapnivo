-- Migration 0075 — launch-readiness check state + transition history.
--
--   system_readiness_check_states — latest evaluated state per stable check id.
--   system_readiness_events       — append-only transition log (state changes
--                                   only; never overwritten, never deleted by app code).
--
-- Both are service-role only: RLS enabled with NO policies (deny-all for
-- anon/authenticated), matching the mobile_devices pattern. The launch
-- readiness engine upserts states and appends events best-effort on evaluation;
-- a failed write never breaks the dashboard.

create table if not exists system_readiness_check_states (
  check_id text primary key,
  subsystem text not null,
  state text not null,
  severity text not null default 'medium',
  evidence text,
  first_seen_at timestamptz not null default now(),
  last_changed_at timestamptz not null default now(),
  last_checked_at timestamptz not null default now()
);

create table if not exists system_readiness_events (
  id bigint generated always as identity primary key,
  check_id text not null,
  previous_state text,
  new_state text not null,
  evidence text,
  actor text not null default 'system',
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists system_readiness_events_check_idx on system_readiness_events (check_id, created_at desc);
create index if not exists system_readiness_events_created_idx on system_readiness_events (created_at desc);

alter table system_readiness_check_states enable row level security;
alter table system_readiness_events enable row level security;
-- No policies: deny-all for anon/authenticated; service role bypasses RLS.
