-- Migration 0021 — per-message email sender routing.
-- sender holds the EmailSenderId (see src/lib/email/senders.ts); reply_to is an
-- optional explicit override. template/event record which registry entry produced
-- the message for debugging and future analytics. All nullable — legacy rows stay null.

alter table email_outbox
  add column if not exists sender text,
  add column if not exists reply_to text,
  add column if not exists template text,
  add column if not exists event text;

create index if not exists email_outbox_sender_idx on email_outbox (sender);
