-- Migration 0013 — rental state machine, durable SMS schedule engine, editable templates, kill switches.

-- 1) Authoritative rental states — rentals.state is a Postgres enum; add new values
--    (enum values can't be removed, so legacy states remain valid and map onto the machine).
alter type rental_state add value if not exists 'pending_payment';
alter type rental_state add value if not exists 'payment_authorized';
alter type rental_state add value if not exists 'return_pending';
alter type rental_state add value if not exists 'overdue';
alter type rental_state add value if not exists 'non_return_fee_pending';
alter type rental_state add value if not exists 'non_return_fee_paid';
alter type rental_state add value if not exists 'closed';
alter type rental_state add value if not exists 'disputed';

alter table rentals add column if not exists sms_consent boolean not null default false;
alter table rentals add column if not exists accrued_charge_cents integer;
alter table rentals add column if not exists non_return_fee_status text check (non_return_fee_status in ('none','pending','charged','failed','waived')) default 'none';

-- 2) Durable notification jobs — per-rental dedupe via unique (rental_id, kind),
--    atomic claim via status transition, exponential backoff via attempts/next_attempt.
create table if not exists notification_jobs (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references rentals(id) on delete cascade,
  kind text not null check (kind in ('activation','reminder_1h','reminder_3h','reminder_6h','reminder_12h','warning_20h','warning_23h','deadline_24h')),
  due_at timestamptz not null,
  status text not null default 'queued' check (status in ('queued','sending','sent','failed','cancelled')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (rental_id, kind)
);
create index if not exists notification_jobs_due_idx on notification_jobs (status, due_at);
alter table notification_jobs enable row level security;
create policy staff_read_notification_jobs on notification_jobs for select using (is_staff());

-- 3) Editable SMS templates (admin-edited; code falls back to defaults when absent).
create table if not exists sms_templates (
  kind text primary key,
  body text not null check (char_length(body) between 10 and 480),
  updated_by uuid references profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table sms_templates enable row level security;
create policy staff_read_templates on sms_templates for select using (is_staff());

-- 4) Emergency kill switches via system_config (key/value, admin-managed).
insert into system_config (key, value) values
  ('sms_enabled', 'true'), ('non_return_billing_enabled', 'true')
on conflict (key) do nothing;
