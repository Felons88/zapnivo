-- Migration 0004 — helpdesk operations
-- Threaded tickets with AI/human handling state, SLA clocks, queues, partner (venue) requests,
-- refund workflow (request → approve → issue) with a one-open-per-rental guard, audit timeline,
-- and an email outbox. All writes go through server-side code using the service role.

create type ai_state as enum ('none', 'ai_active', 'needs_human', 'human');
create type ticket_queue as enum ('customer', 'billing', 'partner', 'safety');
create type refund_status as enum ('requested', 'approved', 'denied', 'issued', 'failed');
create type refund_reason as enum ('failed_dispense', 'return_not_recognized', 'defective_equipment', 'overcharge', 'goodwill');

alter table support_tickets
  add column if not exists subject text,
  add column if not exists queue ticket_queue not null default 'customer',
  add column if not exists requester_type text not null default 'customer' check (requester_type in ('customer', 'partner')),
  add column if not exists organization_id uuid references organizations(id),
  add column if not exists venue_id uuid references venues(id),
  add column if not exists venue_label text,
  add column if not exists ai_state ai_state not null default 'none',
  add column if not exists ai_summary text,
  add column if not exists first_response_at timestamptz,
  add column if not exists first_response_due_at timestamptz,
  add column if not exists resolution_due_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists tickets_queue_idx on support_tickets (queue, state, priority);
create index if not exists tickets_org_idx on support_tickets (organization_id);
create index if not exists tickets_assigned_idx on support_tickets (assigned_to);
create index if not exists tickets_updated_idx on support_tickets (updated_at desc);

alter table support_messages
  add column if not exists author_type text not null default 'agent' check (author_type in ('customer', 'partner', 'agent', 'ai', 'system')),
  add column if not exists author_name text;
create index if not exists messages_ticket_idx on support_messages (ticket_id, created_at);

create table if not exists ticket_events (                -- immutable audit timeline
  id bigint generated always as identity primary key,
  ticket_id uuid not null references support_tickets(id) on delete cascade,
  actor text not null,
  type text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ticket_events_ticket_idx on ticket_events (ticket_id, created_at);

create table if not exists refund_requests (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_tickets(id),
  rental_ref text not null,
  payment_intent_id text,
  reason refund_reason not null,
  amount_cents int not null check (amount_cents > 0),
  status refund_status not null default 'requested',
  requires_admin boolean not null default false,
  requested_by text not null,
  decided_by text,
  decision_note text,
  provider_refund_id text unique,                          -- Stripe refund id; UNIQUE blocks double-recording
  error text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  issued_at timestamptz
);
-- At most ONE open (requested) refund per rental: prevents duplicate/overlapping refunds.
create unique index if not exists refund_one_open_per_rental on refund_requests (rental_ref) where status = 'requested';
create index if not exists refund_status_idx on refund_requests (status, created_at);

create table if not exists email_outbox (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid references support_tickets(id) on delete set null,
  to_email citext not null,
  subject text not null,
  body text not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  error text,
  created_at timestamptz not null default now()
);
create index if not exists outbox_status_idx on email_outbox (status, created_at);

alter table ticket_events enable row level security;
alter table refund_requests enable row level security;
alter table email_outbox enable row level security;

create policy staff_ticket_events on ticket_events for select using (is_staff());
create policy staff_refund_requests on refund_requests for all using (is_staff());
create policy staff_outbox on email_outbox for all using (is_staff());

-- Partners can read tickets for their own organization, and the non-internal messages on them.
create policy partner_own_tickets on support_tickets for select using (
  organization_id is not null and organization_id = (select organization_id from profiles where id = auth.uid())
);
create policy partner_own_messages on support_messages for select using (
  not internal and ticket_id in (
    select id from support_tickets where organization_id = (select organization_id from profiles where id = auth.uid())
  )
);
