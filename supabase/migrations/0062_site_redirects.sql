-- Migration 0062 — Website ops: DB-driven redirect rules.
--
--   site_redirects — operator-managed path redirects per site_key. Rows are
--                    ONLY metadata; enforcement/validation lives in
--                    src/lib/system/site-ops.ts (to_path must be a relative
--                    path or a same-host https URL — arbitrary external
--                    redirects are rejected in application code).
--
-- RLS follows 0042/0058: staff SELECT via has_system_access(); ALL writes go
-- through the service role (no authenticated write policies).

create table if not exists site_redirects (
  id uuid primary key default gen_random_uuid(),
  site_key text not null,
  from_path text not null,
  to_path text not null,
  enabled boolean not null default true,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_key, from_path)
);
create index if not exists site_redirects_lookup_idx on site_redirects (site_key, enabled, from_path);

alter table site_redirects enable row level security;

create policy system_staff_site_redirects on site_redirects
  for select using (has_system_access());
