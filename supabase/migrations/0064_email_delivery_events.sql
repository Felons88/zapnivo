-- Migration 0064 — provider delivery-event webhook intake (email_delivery_events).
--
-- Receives normalized delivery events from the transactional email provider
-- (Resend via svix-signed webhooks, or Brevo via shared-secret webhook) at
-- /api/webhooks/email/delivery. One row per provider event; the unique
-- (provider, provider_event_id) pair is the idempotency key — replays are
-- rejected by the constraint, never double-processed.
--
-- PRIVACY: this table NEVER stores a raw recipient address. Correlation is
-- subscriber_id (nullable FK — null when the address isn't a newsletter
-- subscriber, e.g. ticket/reception mail) plus recipient_hash =
-- sha256(lowercase email) for dedup/debug joins. `payload` is a sanitized
-- subset of the provider body (content/headers/addresses stripped).
--
-- RLS: staff read-only. All writes are service-role via the webhook route.

create table if not exists email_delivery_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('brevo','resend')),
  -- Provider-side event/message id — the idempotency key. Unique per provider.
  provider_event_id text not null,
  event_type text not null check (event_type in
    ('accepted','delivered','deferred','soft_bounce','hard_bounce','complaint','unsubscribe','failed')),
  subscriber_id uuid references newsletter_subscribers(id) on delete set null,
  recipient_hash text not null,
  occurred_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed boolean not null default false,
  process_error text
);

create unique index if not exists email_delivery_events_provider_event_key
  on email_delivery_events (provider, provider_event_id);
create index if not exists email_delivery_events_subscriber_idx
  on email_delivery_events (subscriber_id, occurred_at desc);
create index if not exists email_delivery_events_received_idx
  on email_delivery_events (received_at desc);

alter table email_delivery_events enable row level security;

drop policy if exists staff_email_delivery_events on email_delivery_events;
create policy staff_email_delivery_events on email_delivery_events
  for select using (is_staff());
