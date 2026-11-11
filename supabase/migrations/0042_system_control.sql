-- Migration 0042 — system.zapnivo.com technical control plane (Stage 1 foundation).
--
-- Adds a SEPARATE access tier on top of profiles.role: profiles.system_role grants
-- entry to the system console. It is deliberately NOT backfilled — business
-- admin/staff keep system_role NULL and get no system access automatically.
-- Permission strings themselves are code-defined (src/lib/system/rbac.ts); the
-- role column is the only persisted grant.
--
-- Tables: change requests (separation-of-duties approvals), append-only audit
-- events, feature flags (metadata + audit only — env vars still govern runtime
-- behavior), and the beginning of the device fleet registry + command queue.

alter table profiles add column if not exists system_role text
  check (system_role in ('viewer','developer','hardware','engineer','security','sysadmin','breakglass'));
create index if not exists profiles_system_role_idx on profiles (system_role) where system_role is not null;

-- RLS helper: true when the caller's profile carries any system role.
create or replace function has_system_access() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.profiles where id = auth.uid() and system_role is not null) $$;

-- ─── Change requests (high-risk approvals, separation of duties) ─────────────
create table if not exists system_change_requests (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  environment text not null default 'production',
  risk text not null default 'medium' check (risk in ('low','medium','high','critical')),
  justification text not null default '',
  status text not null default 'pending' check (status in ('pending','approved','rejected','executed','failed')),
  requested_by uuid not null,
  decided_by uuid,
  decided_at timestamptz,
  result jsonb,
  created_at timestamptz not null default now()
);
create index if not exists system_cr_status_idx on system_change_requests (status, created_at desc);
create index if not exists system_cr_requester_idx on system_change_requests (requested_by, status);

-- ─── Audit events (append-only; writes go through the service role only) ─────
create table if not exists system_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  actor_role text,
  action text not null,
  resource text not null default '',
  environment text not null default 'production',
  detail jsonb not null default '{}'::jsonb,
  correlation_id text,
  created_at timestamptz not null default now()
);
create index if not exists system_audit_created_idx on system_audit_events (created_at desc);
create index if not exists system_audit_action_idx on system_audit_events (action, created_at desc);
create index if not exists system_audit_resource_idx on system_audit_events (resource, created_at desc);
-- No insert/update/delete policies → authenticated roles can SELECT only;
-- all writes come from the service role in src/lib/system/audit.ts.

-- ─── Feature flags (control-plane metadata; env vars still govern runtime) ──
create table if not exists system_feature_flags (
  key text primary key,
  environment text not null default 'production',
  enabled boolean not null default false,
  description text not null default '',
  owner text not null default 'platform',
  prerequisites jsonb not null default '[]'::jsonb,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
insert into system_feature_flags (key, environment, enabled, description, owner, prerequisites) values
  ('gift_sales',            'production', false, 'Gift-card sales catalog. NOTE: runtime behavior is governed by the gift-sales env flag (src/lib/gifts.ts giftSalesEnabled); this row records intended state + audit trail only.', 'commerce', '["legal sign-off","stripe products"]'::jsonb),
  ('kiosk_adapter',         'production', false, 'Hardware kiosk adapter (non-null adapter). NOTE: actual adapter selection is KIOSK_ADAPTER env; this row is metadata + audit only.', 'hardware', '["adapter implementation","device fleet"]'::jsonb),
  ('membership_sales',      'production', false, 'Membership plan sales. NOTE: checkout is gated by Stripe config + active membership_plans rows; this flag is metadata + audit only.', 'commerce', '["stripe live keys","pricing approval"]'::jsonb),
  ('receptionist_autosend', 'production', false, 'Allow the AI receptionist to auto-send replies without staff approval. Draft-only until enabled AND per-tenant policy allows.', 'ai', '["eval suite green","legal review"]'::jsonb),
  ('ai_account_tools',      'production', false, 'Expose account-management tools to the AI assistant. Requires per-tool allowlist review before enabling.', 'ai', '["tool allowlist","eval suite green"]'::jsonb)
on conflict (key) do nothing;

-- ─── Device fleet registry (Stage 1: schema + RLS only) ──────────────────────
create table if not exists system_devices (
  id uuid primary key default gen_random_uuid(),
  device_uid text unique,
  serial_number text,
  manufacturer text,
  model text,
  gateway text,
  adapter_type text,
  capabilities jsonb not null default '{}'::jsonb,
  slot_count int,
  firmware_version text,
  venue_id uuid references venues(id) on delete set null,
  region text,
  status text not null default 'registered'
    check (status in ('pending','registered','provisioning','testing','active','maintenance','suspended','quarantined','decommissioned')),
  provision_token_hash text,
  provision_token_expires_at timestamptz,
  provision_token_used_at timestamptz,
  credential_rotated_at timestamptz,
  installed_at timestamptz,
  last_heartbeat_at timestamptz,
  last_message_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists system_devices_serial_idx on system_devices (serial_number);
create index if not exists system_devices_status_idx on system_devices (status);

-- ─── Device command queue (future hardware commands; Stage 1 schema only) ────
create table if not exists system_device_commands (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references system_devices(id) on delete cascade,
  command_type text not null,
  payload jsonb not null default '{}'::jsonb,
  state text not null default 'pending'
    check (state in ('pending','sent','acked','failed','timeout','cancelled')),
  idempotency_key text unique,
  issued_by uuid,
  authorized_by uuid,
  result jsonb,
  timeout_at timestamptz,
  acked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists system_device_commands_device_idx on system_device_commands (device_id, created_at desc);
create index if not exists system_device_commands_state_idx on system_device_commands (state, created_at);

-- ─── RLS: any system_role holder gets full access; audit_events select-only ──
alter table system_change_requests enable row level security;
alter table system_audit_events enable row level security;
alter table system_feature_flags enable row level security;
alter table system_devices enable row level security;
alter table system_device_commands enable row level security;

drop policy if exists system_staff_changes on system_change_requests;
create policy system_staff_changes on system_change_requests for all using (has_system_access()) with check (has_system_access());

drop policy if exists system_staff_audit on system_audit_events;
create policy system_staff_audit on system_audit_events for select using (has_system_access());

drop policy if exists system_staff_flags on system_feature_flags;
create policy system_staff_flags on system_feature_flags for all using (has_system_access()) with check (has_system_access());

drop policy if exists system_staff_devices on system_devices;
create policy system_staff_devices on system_devices for all using (has_system_access()) with check (has_system_access());

drop policy if exists system_staff_device_commands on system_device_commands;
create policy system_staff_device_commands on system_device_commands for all using (has_system_access()) with check (has_system_access());
