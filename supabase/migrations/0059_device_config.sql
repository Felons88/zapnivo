-- 0059_device_config.sql
-- Kiosk operations expansion (System Control → KIOSK INFRASTRUCTURE):
--   1. device_config_revisions — desired-state configuration revisions per
--      system_devices row. `desired` is whitelist-validated in
--      src/lib/system/device-config.ts (DB stores jsonb; the whitelist is
--      enforced at the application layer, consistent with how
--      system_device_commands.payload is handled).
--   2. system_maintenance_visits — device-level maintenance schedule for
--      system_devices. The legacy `maintenance_visits` table (0001) is keyed
--      to the rental-facing `kiosks` table, has no status workflow, and is
--      read by command-ops for the ops dashboard — it is NOT reused here.
--   3. system_devices.metadata — small jsonb bag for ops tags (bulk
--      assign_tags writes metadata.tags). No secret material belongs here.
--
-- HONESTY NOTES
--   - Status 'awaiting_report' means a config_update command was recorded
--     but the device has not yet reported matching config back. There is
--     currently NO reported-config channel in ingest (src/lib/kiosk/ingest.ts
--     carries telemetry/acks only), and KIOSK_ADAPTER=none means commands are
--     recorded failed/adapter_disabled — revisions normally land 'failed'.
--   - RLS is SELECT-only for system users (has_system_access(), 0043); all
--     writes go through the service role after permission + change-request
--     gates in the API routes/libs.

alter table system_devices
  add column if not exists metadata jsonb not null default '{}'::jsonb;

comment on column system_devices.metadata is
  'Ops metadata bag (tags etc.). Whitelist-managed by src/lib/system — never store secrets or credential material.';

-- ─── Desired-state device configuration revisions ──────────────────────────
create table if not exists device_config_revisions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references system_devices(id) on delete cascade,
  revision int not null,
  desired jsonb not null,
  status text not null default 'draft'
    check (status in ('draft','approved','applied','failed','superseded','awaiting_report')),
  command_id uuid references system_device_commands(id) on delete set null,
  reported jsonb,
  actor uuid,
  created_at timestamptz not null default now(),
  unique (device_id, revision)
);

comment on table device_config_revisions is
  'Append-only-ish desired-state config revisions for system_devices. desired keys are whitelist-validated in src/lib/system/device-config.ts. reported holds the device-reported config once a reported-state channel exists (none today — see ingest.ts).';

create index if not exists device_config_revisions_device_idx
  on device_config_revisions (device_id, revision desc);
create index if not exists device_config_revisions_status_idx
  on device_config_revisions (status, created_at desc);

alter table device_config_revisions enable row level security;

drop policy if exists system_staff_device_config on device_config_revisions;
create policy system_staff_device_config on device_config_revisions
  for select using (has_system_access());

-- ─── Device-level maintenance visits (system_devices) ─────────────────────
create table if not exists system_maintenance_visits (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references system_devices(id) on delete cascade,
  visit_type text not null default 'routine'
    check (visit_type in ('routine','repair','firmware','inspection','other')),
  status text not null default 'open'
    check (status in ('open','scheduled','in_progress','completed','cancelled')),
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  technician text,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table system_maintenance_visits is
  'Maintenance schedule/workflow for system_devices (open→scheduled→in_progress→completed|cancelled). Distinct from legacy maintenance_visits which is keyed to rental-facing kiosks.';

create index if not exists system_maintenance_visits_device_idx
  on system_maintenance_visits (device_id, created_at desc);
create index if not exists system_maintenance_visits_status_idx
  on system_maintenance_visits (status, scheduled_at);

alter table system_maintenance_visits enable row level security;

drop policy if exists system_staff_sys_maintenance on system_maintenance_visits;
create policy system_staff_sys_maintenance on system_maintenance_visits
  for select using (has_system_access());
