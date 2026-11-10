-- Migration 0015 — kiosk lifecycle: event dedupe/replay protection, verified returns, dispute flag.
--
-- 1) kiosk_events — processing ledger for authenticated device events. event_id is the
--    replay-protection key (unique; NULLs allowed for vendors that don't supply ids).
--    processed_at/result are stamped by the service layer once the event is handled.
create table if not exists kiosk_events (
  id bigint generated always as identity primary key,
  event_id text unique,
  kiosk_id uuid not null references kiosks(id) on delete cascade,
  type text not null,
  payload jsonb,
  occurred_at timestamptz,                    -- device-reported time, when supplied
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  result text                                -- heartbeat | returned | return_disputed | rejected:* | duplicate | out_of_order | ...
);
create index if not exists kiosk_events_kiosk_idx on kiosk_events (kiosk_id, received_at desc);
create index if not exists kiosk_events_unprocessed_idx on kiosk_events (received_at) where processed_at is null;

-- 2) rentals.return_disputed — set when a dock event arrives after the non-return deadline
--    (offline/delayed sync). The bank is marked returned, but staff must review before any
--    non-return fee is assessed. Never set by customer-facing paths.
alter table rentals add column if not exists return_disputed boolean not null default false;
create index if not exists rentals_return_disputed_idx on rentals (return_disputed) where return_disputed;

-- kiosks already carry last_seen_at (heartbeat), firmware_version and state — no new columns needed.

-- RLS: service-role writes only (same posture as device_events after migration 0006).
alter table kiosk_events enable row level security;
create policy staff_read_kiosk_events on kiosk_events for select using (is_staff());
