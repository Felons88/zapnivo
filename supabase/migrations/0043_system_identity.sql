-- Migration 0043 — system identity hardening (Phase 1+2).
--
-- Adds the primitives for privileged bootstrap, MFA step-up elevation, and
-- technical-user suspension on top of the 0042 system control plane:
--
--   * profiles.system_suspended — a suspended technical user loses ALL system
--     access even while profiles.system_role is still set. has_system_access()
--     is updated so RLS agrees with the app-layer systemRole() check.
--   * system_elevations — short-lived step-up grants (15 min) issued after a
--     successful TOTP verify (or password re-auth). They authorize a single
--     high-risk action window; they NEVER extend the 24h session.
--   * system_bootstrap_grants — one-time audit record for the env-token
--     bootstrap path that grants profiles.system_role='sysadmin' to a user who
--     has none. consumed_at marks the grant as spent so replay fails.
--
-- All tables are written exclusively through the service role
-- (src/lib/system/*); authenticated roles get SELECT-only via has_system_access().

alter table profiles add column if not exists system_suspended boolean not null default false;

-- Suspended technical users lose system access even with a system_role.
create or replace function has_system_access() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from public.profiles
     where id = auth.uid() and system_role is not null and system_suspended = false
   ) $$;

-- ─── Step-up elevations (short-lived action windows) ─────────────────────────
create table if not exists system_elevations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  method text not null check (method in ('totp','password')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_action text,
  created_ip text
);
create index if not exists system_elevations_profile_idx on system_elevations (profile_id, expires_at desc);
create index if not exists system_elevations_expiry_idx on system_elevations (expires_at) where consumed_action is null;

-- ─── Bootstrap grants (one-time sysadmin bootstrap audit) ────────────────────
create table if not exists system_bootstrap_grants (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  granted_by text not null,
  method text not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);
-- One bootstrap grant per profile, ever — replay is impossible at the DB level too.
create unique index if not exists system_bootstrap_grants_profile_idx on system_bootstrap_grants (profile_id);
create index if not exists system_bootstrap_grants_created_idx on system_bootstrap_grants (created_at desc);

-- ─── RLS: staff-select only, consistent with 0042 ────────────────────────────
alter table system_elevations enable row level security;
alter table system_bootstrap_grants enable row level security;

drop policy if exists system_staff_elevations on system_elevations;
create policy system_staff_elevations on system_elevations for select using (has_system_access());

drop policy if exists system_staff_bootstrap_grants on system_bootstrap_grants;
create policy system_staff_bootstrap_grants on system_bootstrap_grants for select using (has_system_access());
