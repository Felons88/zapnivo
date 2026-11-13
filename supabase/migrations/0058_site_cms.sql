-- Migration 0058 — Website Management Center (site CMS).
--
--   site_content            — one row per (site_key, page_key, field_key, locale):
--                              draft_value / published_value jsonb, lifecycle status
--                              (draft | published | scheduled), scheduled_at, version.
--   site_content_revisions  — append-only history of save_draft / publish /
--                              schedule / revert actions with the actor.
--   site_media              — metadata registry for CMS-managed media. Bytes live in
--                              Supabase Storage (service-role only); this table stores
--                              path/url references, alt text, mime, size — never blobs.
--
-- RLS follows 0042/0045: staff SELECT via has_system_access(); ALL writes go through
-- the service role in src/lib/system/site-cms.ts (no authenticated write policies).
-- Values are sanitized in application code BEFORE insert — the DB stores plain
-- scalars/jsonb only; no HTML is ever rendered from these columns.

-- ─── Content rows ────────────────────────────────────────────────────────────
create table if not exists site_content (
  id uuid primary key default gen_random_uuid(),
  site_key text not null,
  page_key text not null,
  field_key text not null,
  locale text not null default 'en',
  draft_value jsonb,
  published_value jsonb,
  status text not null default 'draft' check (status in ('draft','published','scheduled')),
  scheduled_at timestamptz,
  version int not null default 0,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_key, page_key, field_key, locale)
);
create index if not exists site_content_lookup_idx on site_content (site_key, page_key, locale);
create index if not exists site_content_status_idx on site_content (status, scheduled_at);

-- ─── Revision history (append-only) ──────────────────────────────────────────
create table if not exists site_content_revisions (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references site_content (id) on delete cascade,
  version int not null,
  value jsonb,
  action text not null check (action in ('save_draft','publish','schedule','revert')),
  actor uuid,
  created_at timestamptz not null default now()
);
create index if not exists site_content_revisions_content_idx
  on site_content_revisions (content_id, created_at desc);

-- ─── Media registry (metadata only — bytes via Supabase Storage) ─────────────
create table if not exists site_media (
  id uuid primary key default gen_random_uuid(),
  site_key text not null,
  path text not null,
  url text,
  alt_text text not null default '',
  mime text,
  bytes int,
  storage_bucket text,
  uploaded_by uuid,
  created_at timestamptz not null default now(),
  unique (site_key, path)
);
create index if not exists site_media_site_idx on site_media (site_key, created_at desc);

-- ─── RLS: staff read, service-role writes ────────────────────────────────────
alter table site_content enable row level security;
alter table site_content_revisions enable row level security;
alter table site_media enable row level security;

create policy system_staff_site_content on site_content
  for select using (has_system_access());

create policy system_staff_site_content_revisions on site_content_revisions
  for select using (has_system_access());

create policy system_staff_site_media on site_media
  for select using (has_system_access());
