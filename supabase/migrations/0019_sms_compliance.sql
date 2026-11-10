-- Migration 0019 — SMS compliance & remaining notification triggers.
-- 1) sms_opt_outs: phone-level STOP/START state (E.164), independent of marketing consent.
-- 2) sms_messages: provider error capture (Twilio error code/message on failed sends).
-- 3) notification_jobs: event-driven kinds (return_failed, non_return_fee_charged,
--    payment_failed, ticket_received); rental_id becomes optional so ticket confirmations
--    can dedupe on (ticket_id, kind) instead.

create table if not exists sms_opt_outs (
  phone text primary key,                       -- E.164, e.g. +15551234567
  source text not null default 'inbound_sms',
  created_at timestamptz not null default now()
);
alter table sms_opt_outs enable row level security;
drop policy if exists staff_read_sms_opt_outs on sms_opt_outs;
create policy staff_read_sms_opt_outs on sms_opt_outs for select using (is_staff());

alter table sms_messages add column if not exists error_code text;
alter table sms_messages add column if not exists error_message text;

alter table notification_jobs alter column rental_id drop not null;
alter table notification_jobs add column if not exists ticket_id uuid references support_tickets(id) on delete cascade;

-- Widen the kind check to cover the event-driven job types.
alter table notification_jobs drop constraint if exists notification_jobs_kind_check;
alter table notification_jobs add constraint notification_jobs_kind_check check (kind in (
  'activation','reminder_1h','reminder_3h','reminder_6h','reminder_12h',
  'warning_20h','warning_23h','deadline_24h',
  'return_failed','non_return_fee_charged','payment_failed','ticket_received'
));

-- Ticket-scoped dedupe. NULL ticket_id rows (rental jobs) never conflict because
-- Postgres treats NULLs as distinct in unique indexes; the existing
-- unique (rental_id, kind) constraint keeps covering rental jobs.
create unique index if not exists notification_jobs_ticket_dedupe
  on notification_jobs (ticket_id, kind);
create index if not exists notification_jobs_ticket_idx on notification_jobs (ticket_id);
