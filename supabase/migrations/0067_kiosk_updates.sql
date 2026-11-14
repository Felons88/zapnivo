-- Migration 0067 — remote kiosk update & release management.
--
-- Software/firmware/config/display-manifest release registry, rollout
-- campaigns, and per-device update state machines for system.zapnivo.com.
--
-- HONESTY RULES baked into the schema:
--  - A release row is METADATA + approval state. Artifact bytes live in a
--    private storage bucket; this table never stores executable content.
--  - signature_status starts 'unsigned'; only 'verified' artifacts may be
--    approved for firmware/software kinds (enforced in app code AND by a
--    check constraint below for firmware).
--  - Once a release is 'approved' its artifact fields are IMMUTABLE — a
--    trigger rejects changes to kind/version/checksum/path/signature. Only
--    status transitions approved→deprecated|revoked are permitted.
--  - Update targets track the typed lifecycle
--    draft→approved→scheduled→queued→transferring→installing→reconnecting→
--    verifying→completed with failure/unknown_outcome/investigating/recovery
--    branches. 'completed' requires verified device telemetry — enforced in
--    app code; the schema only stores the claim + evidence jsonb.
--
-- RLS: same system_role model as 0042 — has_system_access() for all ops.

-- ─── Release registry ──────────────────────────────────────────────────────
create table if not exists kiosk_update_releases (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('firmware','software','config','display_manifest')),
  version text not null check (length(version) between 1 and 120),
  channel text not null default 'stable' check (channel in ('canary','beta','stable')),
  manufacturer text,
  model text,
  hw_revision_min text,
  -- Private storage coordinates. Bucket must be private; path is opaque.
  storage_bucket text,
  storage_path text,
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  signature_status text not null default 'unsigned'
    check (signature_status in ('unsigned','signed','verified','rejected')),
  signature_key_id text,
  release_notes text,
  status text not null default 'draft'
    check (status in ('draft','approved','deprecated','revoked')),
  uploaded_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists kiosk_update_releases_uniq
  on kiosk_update_releases (kind, version, channel, manufacturer, model) nulls not distinct;
create index if not exists kiosk_update_releases_status_idx on kiosk_update_releases (status, kind);

-- Firmware/software artifacts MUST be signature-verified before approval.
alter table kiosk_update_releases
  drop constraint if exists kiosk_update_releases_verified_chk;
alter table kiosk_update_releases
  add constraint kiosk_update_releases_verified_chk
  check (kind in ('config','display_manifest')
         or signature_status = 'verified'
         or status in ('draft','deprecated','revoked'));

-- Immutability trigger: approved releases are frozen except deprecation.
create or replace function kiosk_update_release_immutable() returns trigger
language plpgsql as $$
begin
  if old.status = 'approved' then
    if new.kind is distinct from old.kind
       or new.version is distinct from old.version
       or new.channel is distinct from old.channel
       or new.manufacturer is distinct from old.manufacturer
       or new.model is distinct from old.model
       or new.hw_revision_min is distinct from old.hw_revision_min
       or new.storage_bucket is distinct from old.storage_bucket
       or new.storage_path is distinct from old.storage_path
       or new.sha256 is distinct from old.sha256
       or new.signature_status is distinct from old.signature_status
       or new.signature_key_id is distinct from old.signature_key_id
       or new.release_notes is distinct from old.release_notes
       or new.uploaded_by is distinct from old.uploaded_by
       or new.approved_by is distinct from old.approved_by
       or new.approved_at is distinct from old.approved_at then
      raise exception 'approved kiosk_update_releases rows are immutable (only status may change to deprecated/revoked)';
    end if;
    if new.status not in ('approved','deprecated','revoked') then
      raise exception 'approved release status may only move to deprecated or revoked';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists kiosk_update_release_immutable_trg on kiosk_update_releases;
create trigger kiosk_update_release_immutable_trg
  before update on kiosk_update_releases
  for each row execute function kiosk_update_release_immutable();

-- ─── Rollout campaigns ─────────────────────────────────────────────────────
create table if not exists kiosk_update_campaigns (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references kiosk_update_releases(id) on delete restrict,
  name text not null check (length(name) between 1 and 200),
  justification text not null default '',
  -- draft → pending_approval → approved → scheduled → active → paused →
  -- completed | failed | cancelled | blocked
  status text not null default 'draft'
    check (status in ('draft','pending_approval','approved','scheduled','active',
                      'paused','completed','failed','cancelled','blocked')),
  -- Target selection: { device_ids?, models?, regions?, venues?, canary_percent?, tags? }
  target_filter jsonb not null default '{}'::jsonb,
  -- { start?: timestamptz, end?: timestamptz, timezone?: text }
  maintenance_window jsonb,
  concurrency_limit int not null default 1 check (concurrency_limit between 1 and 50),
  pause_reason text,
  result jsonb,
  created_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists kiosk_update_campaigns_status_idx on kiosk_update_campaigns (status);
create index if not exists kiosk_update_campaigns_release_idx on kiosk_update_campaigns (release_id);

-- ─── Per-device update state machine ───────────────────────────────────────
create table if not exists kiosk_update_targets (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references kiosk_update_campaigns(id) on delete cascade,
  device_id uuid not null references system_devices(id) on delete cascade,
  -- draft → approved → scheduled → queued → transferring → installing →
  -- reconnecting → verifying → completed
  -- branches: failed | unknown_outcome | investigating | recovery | cancelled
  state text not null default 'draft'
    check (state in ('draft','approved','scheduled','queued','transferring',
                     'installing','reconnecting','verifying','completed',
                     'failed','unknown_outcome','investigating','recovery','cancelled')),
  attempt int not null default 0,
  last_error text,
  -- Evidence captured at 'completed' (telemetry version + health checks).
  result jsonb,
  state_entered_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, device_id)
);
create index if not exists kiosk_update_targets_state_idx on kiosk_update_targets (state);
create index if not exists kiosk_update_targets_device_idx on kiosk_update_targets (device_id, created_at desc);

-- ─── RLS ───────────────────────────────────────────────────────────────────
alter table kiosk_update_releases enable row level security;
alter table kiosk_update_campaigns enable row level security;
alter table kiosk_update_targets enable row level security;

drop policy if exists system_staff_update_releases on kiosk_update_releases;
create policy system_staff_update_releases on kiosk_update_releases
  for all using (has_system_access()) with check (has_system_access());
drop policy if exists system_staff_update_campaigns on kiosk_update_campaigns;
create policy system_staff_update_campaigns on kiosk_update_campaigns
  for all using (has_system_access()) with check (has_system_access());
drop policy if exists system_staff_update_targets on kiosk_update_targets;
create policy system_staff_update_targets on kiosk_update_targets
  for all using (has_system_access()) with check (has_system_access());
