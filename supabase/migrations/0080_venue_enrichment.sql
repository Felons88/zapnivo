-- Venue enrichment for the Mapbox-powered venue platform (spec §1, §5).
--
--   mapbox_id        — Mapbox feature id from Search Box retrieve; the
--                      authoritative external identity used for dedupe. Unique
--                      per venue when present (partial unique index).
--   phone / website / description / cover_image_url — public listing fields.
--   timezone         — IANA zone used to interpret `hours` for customers.
--   accessibility    — optional public accessibility note (wheelchair access…).
--   internal_notes / contact_* — INTERNAL ONLY. Never serialized by public
--                      endpoints (getStations exposes a curated allowlist).
--   active           — operational status, independent from `published`:
--                      published+active = publicly listed; active=false keeps
--                      the venue listed internally but out of service.

alter table venues
  add column if not exists mapbox_id text,
  add column if not exists phone text,
  add column if not exists website text,
  add column if not exists description text,
  add column if not exists cover_image_url text,
  add column if not exists timezone text,
  add column if not exists accessibility text,
  add column if not exists internal_notes text,
  add column if not exists contact_name text,
  add column if not exists contact_email text,
  add column if not exists contact_phone text,
  add column if not exists active boolean not null default true;

comment on column venues.internal_notes is 'Internal ops notes — never expose on public surfaces.';
comment on column venues.contact_name is 'Internal venue contact — never expose on public surfaces.';

create unique index if not exists venues_mapbox_id_uidx
  on venues (mapbox_id) where mapbox_id is not null;
create index if not exists venues_public_idx on venues (published, active);

-- NOTE on realtime (spec §6): venues/kiosk_slots are deliberately NOT added
-- to supabase_realtime. Realtime respects RLS row policies but broadcasts the
-- FULL row — a public select policy on venues would leak internal_notes /
-- contact_* to every customer device. Public consumers sync through the
-- curated API surface instead: the website revalidates (ISR 300s) and the app
-- polls + pull-to-refreshes /api/mobile/stations, which only ever emits the
-- public field allowlist.
