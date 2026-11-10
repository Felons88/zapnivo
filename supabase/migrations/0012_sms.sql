-- Migration 0012 — SMS: customer phone from Stripe checkout + message log for the Twilio webhook.
-- RLS: staff SELECT-only; writes via service role (webhook route, triggers).

alter table payments add column if not exists customer_phone text;

create table if not exists sms_messages (
  id uuid primary key default gen_random_uuid(),
  direction text not null check (direction in ('inbound', 'outbound')),
  from_number text not null,
  to_number text not null,
  body text not null,
  status text not null default 'sent',
  provider_sid text unique,
  rental_id uuid references rentals(id) on delete set null,
  ticket_id uuid references support_tickets(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists sms_messages_created_idx on sms_messages (created_at desc);

alter table sms_messages enable row level security;
create policy staff_read_sms on sms_messages for select using (is_staff());
