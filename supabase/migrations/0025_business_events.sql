-- Migration 0025 — first-party business event pipeline.
-- Privacy-minimized analytics: no PII columns by design. Public clients may only
-- submit events on the PUBLIC_EVENT_NAMES allowlist via /api/events; trusted
-- lifecycle events are written server-side with the service role.

create table if not exists business_events (
  id bigint generated always as identity primary key,
  event_id uuid not null default gen_random_uuid(),          -- client-supplied idempotency key when present
  name text not null,
  schema_version int not null default 1,
  source text not null default 'client' check (source in ('client','server')),
  occurred_at timestamptz not null default now(),
  session_ref text,                                          -- opaque, non-identifying
  actor_id uuid,                                             -- auth user id when server-verified; never email/phone
  entity_type text,                                          -- e.g. 'rental','ticket','partner_application'
  entity_id text,
  props jsonb not null default '{}'::jsonb,                  -- allowlisted scalar props only
  privacy_class text not null default 'public' check (privacy_class in ('public','internal')),
  consent_state text not null default 'unknown' check (consent_state in ('granted','denied','unknown')),
  status text not null default 'recorded' check (status in ('recorded','aggregated','deleted')),
  created_at timestamptz not null default now()
);

-- Idempotent ingestion: a client retry with the same event_id collapses to one row.
create unique index if not exists business_events_event_id_idx on business_events (event_id);
create index if not exists business_events_name_time_idx on business_events (name, occurred_at desc);
create index if not exists business_events_entity_idx on business_events (entity_type, entity_id);
create index if not exists business_events_occurred_idx on business_events (occurred_at desc);

alter table business_events enable row level security;
-- Staff read analytics; all writes go through the service role in /api/events and server code.
drop policy if exists staff_business_events on business_events;
create policy staff_business_events on business_events for select using (is_staff());
