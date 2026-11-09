-- Migration 0008 — ops tooling: internal notes, staff prefs, saved views, install files, cron monitor.
-- Convention (see 0006): staff JWTs are SELECT-only; every write goes through the service role.

create table if not exists internal_notes (
  id uuid primary key default gen_random_uuid(),
  entity text not null check (entity in ('rental', 'venue', 'kiosk', 'organization')),
  entity_id uuid not null,
  body text not null check (char_length(body) between 1 and 4000),
  author uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists internal_notes_entity_idx on internal_notes (entity, entity_id, created_at desc);

create table if not exists notification_prefs (
  profile_id uuid primary key references profiles(id) on delete cascade,
  offline_alerts boolean not null default true,
  low_battery_alerts boolean not null default true,
  new_partner_inquiries boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists saved_views (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  query text not null check (char_length(query) <= 500),   -- querystring for /admin/support
  created_at timestamptz not null default now()
);
create index if not exists saved_views_profile_idx on saved_views (profile_id);

create table if not exists installation_files (
  id uuid primary key default gen_random_uuid(),
  kiosk_id uuid not null references kiosks(id) on delete cascade,
  kind text not null default 'photo' check (kind in ('photo', 'document')),
  storage_path text not null,
  caption text,
  uploaded_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists cron_runs (
  id bigint generated always as identity primary key,
  job text not null,
  ok boolean not null,
  detail jsonb,
  ran_at timestamptz not null default now()
);
create index if not exists cron_runs_job_idx on cron_runs (job, ran_at desc);

alter table kiosks add column if not exists disabled_reason text;
alter table kiosks add column if not exists offline_alerted_at timestamptz;
alter table power_banks add column if not exists low_battery_alerted_at timestamptz;

alter table internal_notes enable row level security;
alter table notification_prefs enable row level security;
alter table saved_views enable row level security;
alter table installation_files enable row level security;
alter table cron_runs enable row level security;

create policy staff_read_notes on internal_notes for select using (is_staff());
create policy staff_read_prefs on notification_prefs for select using (is_staff());
create policy own_saved_views on saved_views for select using (profile_id = auth.uid());
create policy staff_read_install_files on installation_files for select using (is_staff());
create policy staff_read_cron on cron_runs for select using (is_staff());

insert into storage.buckets (id, name, public) values ('station-files', 'station-files', false)
on conflict (id) do nothing;
