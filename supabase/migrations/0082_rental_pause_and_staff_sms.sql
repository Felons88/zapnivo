-- Migration 0082 — rental pause + staff-action SMS kinds.
--
-- Pause bookkeeping on rentals: paused_at marks an open pause window (the billing
-- clock is stopped); paused_seconds accumulates every completed pause window.
-- Settlement subtracts total paused time from the chargeable period and resume
-- pushes non_return_deadline forward by the paused duration.

alter table rentals
  add column if not exists paused_at timestamptz,
  add column if not exists paused_seconds int not null default 0 check (paused_seconds >= 0);
create index if not exists rentals_paused_idx on rentals (paused_at) where paused_at is not null;

-- Staff-action notifications are transactional (they confirm something that
-- already happened to the customer's rental) — same delivery posture as
-- non_return_fee_charged / payment_failed.
alter table notification_jobs drop constraint if exists notification_jobs_kind_check;
alter table notification_jobs add constraint notification_jobs_kind_check check (kind in (
  'activation','reminder_1h','reminder_3h','reminder_6h','reminder_12h',
  'warning_20h','warning_23h','deadline_24h',
  'return_failed','non_return_fee_charged','payment_failed','ticket_received',
  'rental_paused','rental_resumed','rental_extended'
));
