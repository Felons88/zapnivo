-- Migration 0044 — system control phases 4/5/7: per-device kiosk credentials,
-- auth telemetry, hardware profiles, and incident lifecycle history.
--
-- 1. system_devices gains per-device ingest credential columns. Only a SHA-256
--    derived signing key is ever stored — the raw secret is shown once at issue
--    time and is NEVER persisted. `auth_method` records how the device is
--    expected to authenticate ('pending' until a credential is issued).
-- 2. system_device_messages — append-only auth telemetry (one row per ingest
--    auth attempt). NEVER contains secrets or signatures.
-- 3. system_incident_events — append-only incident status transition history.
-- 4. system_hardware_profiles — vendor hardware capability/certification
--    registry. Seeded EMPTY on purpose: no hardware profile may be claimed
--    until a real unit + vendor docs have been inspected and test results
--    recorded. Rows are added via ops migrations only — there is no write API.
-- 5. incidents.status check widened to allow 'reopened' (incident lifecycle:
--    detected → investigating → identified → mitigating → monitoring →
--    resolved, with reopen edges back into the workflow).

-- ─── 1. Per-device credential columns on system_devices ─────────────────────
alter table system_devices
  add column if not exists device_secret_hash text,
  add column if not exists credential_issued_at timestamptz,
  add column if not exists credential_expires_at timestamptz,
  add column if not exists credential_revoked_at timestamptz,
  add column if not exists auth_method text not null default 'pending'
    check (auth_method in ('pending','hmac_sha256','shared_secret_legacy','none')),
  add column if not exists last_authed_at timestamptz,
  add column if not exists last_message_ts bigint;

create index if not exists system_devices_auth_method_idx on system_devices (auth_method) where auth_method <> 'pending';

-- ─── 2. Auth telemetry (append-only; service-role writes only) ──────────────
create table if not exists system_device_messages (
  id uuid primary key default gen_random_uuid(),
  device_id uuid references system_devices(id) on delete cascade, -- null for unattributed/global attempts
  message_type text not null default 'ingest',
  received_at timestamptz not null default now(),
  auth_method text,
  result text not null check (result in ('ok','rejected')),
  detail jsonb not null default '{}'::jsonb
);
create index if not exists system_device_messages_device_idx on system_device_messages (device_id, received_at desc);
create index if not exists system_device_messages_result_idx on system_device_messages (result, received_at desc);

-- ─── 3. Incident transition history (append-only) ───────────────────────────
create table if not exists system_incident_events (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_id uuid,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists system_incident_events_incident_idx on system_incident_events (incident_id, created_at);

-- Widen the incidents status CHECK to include 'reopened' (reopen = resolved or
-- monitoring incident returns to the workflow with a mandatory reason).
alter table incidents drop constraint if exists incidents_status_check;
alter table incidents add constraint incidents_status_check
  check (status in ('detected','investigating','identified','mitigating','monitoring','resolved','reopened'));

-- ─── 4. Hardware profiles (ops-managed; intentionally EMPTY) ────────────────
create table if not exists system_hardware_profiles (
  id uuid primary key default gen_random_uuid(),
  manufacturer text not null,
  model text not null,
  protocol_doc_url text,
  gateway_api_spec text,
  auth_capabilities jsonb not null default '{}'::jsonb,
  dispense_supported boolean not null default false,
  return_detection boolean not null default false,
  inventory_reporting boolean not null default false,
  heartbeat_supported boolean not null default false,
  firmware_update boolean not null default false,
  ad_screen boolean not null default false,
  certification_status text not null default 'uncertified'
    check (certification_status in ('uncertified','in_review','certified','deprecated')),
  test_results jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (manufacturer, model)
);
create index if not exists system_hardware_profiles_cert_idx on system_hardware_profiles (certification_status);

-- ─── RLS: system staff only; telemetry/history are select-only ──────────────
alter table system_device_messages enable row level security;
alter table system_incident_events enable row level security;
alter table system_hardware_profiles enable row level security;

drop policy if exists system_staff_device_messages on system_device_messages;
create policy system_staff_device_messages on system_device_messages
  for select using (has_system_access());

drop policy if exists system_staff_incident_events on system_incident_events;
create policy system_staff_incident_events on system_incident_events
  for select using (has_system_access());

drop policy if exists system_staff_hardware_profiles on system_hardware_profiles;
create policy system_staff_hardware_profiles on system_hardware_profiles
  for all using (has_system_access()) with check (has_system_access());
