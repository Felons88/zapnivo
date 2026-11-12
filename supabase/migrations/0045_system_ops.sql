-- Migration 0045 — System Control phases 8+9+10: retention, recovery, deploy-ops.
--
--   system_retention_runs        — history of automated retention sweeps
--                                  (dry-run vs execute, per-table deleted counts)
--   system_recovery_tests        — manually-performed restore/DR test records
--                                  (the app cannot verify Supabase provider
--                                  backups; these rows record HUMAN-verified tests)
--   system_deployment_requests   — deployment workflow requests
--                                  (deploy|rollback|promote). Execution itself
--                                  stays manual — no provider token is used.
--
-- RLS follows 0042: staff select via has_system_access(); all writes go through
-- the service role in src/lib/system/*.ts. system_deployment_requests gets a
-- for-all staff policy like system_change_requests (decisions are service-side).

-- ─── Retention run history ───────────────────────────────────────────────────
create table if not exists system_retention_runs (
  id uuid primary key default gen_random_uuid(),
  policy text not null default 'standard',
  mode text not null check (mode in ('dry_run','execute')),
  cutoff timestamptz,
  tables jsonb not null default '[]'::jsonb,
  deleted_counts jsonb not null default '{}'::jsonb,
  duration_ms int,
  status text not null default 'completed' check (status in ('completed','partial','failed')),
  error text,
  created_at timestamptz not null default now()
);
create index if not exists system_retention_runs_created_idx on system_retention_runs (created_at desc);
create index if not exists system_retention_runs_mode_idx on system_retention_runs (mode, created_at desc);

-- ─── Recovery / DR test records ──────────────────────────────────────────────
create table if not exists system_recovery_tests (
  id uuid primary key default gen_random_uuid(),
  tested_at timestamptz not null default now(),
  environment text not null default 'production',
  method text not null default '',
  result text not null check (result in ('passed','failed','partial')),
  rpo_minutes int,
  rto_minutes int,
  notes text,
  actor_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists system_recovery_tests_tested_idx on system_recovery_tests (tested_at desc);

-- ─── Deployment requests (workflow only — never executes provider calls) ─────
create table if not exists system_deployment_requests (
  id uuid primary key default gen_random_uuid(),
  action text not null check (action in ('deploy','rollback','promote')),
  target_env text not null default 'production',
  justification text not null,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','executed','failed')),
  requested_by uuid not null,
  decided_by uuid,
  decided_at timestamptz,
  result jsonb,
  created_at timestamptz not null default now()
);
create index if not exists system_deploy_req_status_idx on system_deployment_requests (status, created_at desc);
create index if not exists system_deploy_req_requester_idx on system_deployment_requests (requested_by, status);

-- ─── Retention-supporting indexes on telemetry tables ────────────────────────
-- Only where no usable time-column index exists. error_events(occurred_at),
-- app_logs(ts), trace_spans(created_at), ai_agent_runs(created_at),
-- inbound_jobs(created_at) and email_outbox(status, created_at) already have
-- covering indexes from 0004/0023/0026/0029 — do not duplicate them.
create index if not exists cron_runs_ran_at_idx on cron_runs (ran_at);
create index if not exists uptime_checks_checked_at_idx on uptime_checks (checked_at);

-- system_device_messages arrives in migration 0044 (device-auth/hardware track,
-- owned by another workstream). Its time column is received_at (not created_at).
-- Create the retention index ONLY if the table already exists so this migration
-- never fails on ordering; 0044's (result, received_at desc) index partially
-- covers the sweep but a bare received_at index is cheaper for cutoff scans.
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'system_device_messages') then
    execute 'create index if not exists system_device_messages_received_idx on system_device_messages (received_at)';
  end if;
end $$;

-- ─── RLS ─────────────────────────────────────────────────────────────────────
alter table system_retention_runs enable row level security;
alter table system_recovery_tests enable row level security;
alter table system_deployment_requests enable row level security;

-- Select-only for staff; writes are service-role only (same as audit_events).
drop policy if exists system_staff_retention_runs on system_retention_runs;
create policy system_staff_retention_runs on system_retention_runs for select using (has_system_access());

drop policy if exists system_staff_recovery_tests on system_recovery_tests;
create policy system_staff_recovery_tests on system_recovery_tests for select using (has_system_access());

-- Deployment requests mirror system_change_requests: full staff RLS, real
-- authorization + separation-of-duties enforced in src/lib/system/deployops.ts.
drop policy if exists system_staff_deploy_requests on system_deployment_requests;
create policy system_staff_deploy_requests on system_deployment_requests for all using (has_system_access()) with check (has_system_access());
