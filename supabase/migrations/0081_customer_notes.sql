-- Migration 0081 — customer 360 notes.
-- Staff-facing CRM notes attached to a customer identity. Customers are keyed by email
-- because it is the one identifier present on every touchpoint (profiles, payments.
-- receipt_email, support_tickets, customer_data_requests); rentals made as a guest have
-- no profiles row to key on.
-- Convention (see 0008): staff JWTs are SELECT-only; every write goes through the service role.

create table if not exists customer_notes (
  id uuid primary key default gen_random_uuid(),
  customer_email citext not null,
  body text not null check (char_length(body) between 1 and 4000),
  author uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists customer_notes_email_idx on customer_notes (customer_email, created_at desc);

alter table customer_notes enable row level security;
drop policy if exists staff_read_customer_notes on customer_notes;
create policy staff_read_customer_notes on customer_notes for select using (is_staff());
