-- Migration 0022 — inbound email log.
-- Every message posted to /api/webhooks/email/inbound is recorded here for the
-- admin Communication Center: matched tickets, quarantined/rejected mail,
-- auth method used, provider authentication results, and processing latency.
-- message_id + dedupe_hash give replay/duplicate protection. Staff read-only
-- via RLS; only the service role writes.

create table if not exists inbound_emails (
  id uuid primary key default gen_random_uuid(),
  message_id text,
  dedupe_hash text,
  from_email text,
  to_address text,
  subject text,
  ticket_number text,
  status text not null default 'ignored' check (status in ('accepted','quarantined','rejected','ignored','duplicate','error')),
  reason text,
  auth_method text check (auth_method in ('reply_token','legacy_from_match') or auth_method is null),
  dmarc_result text,
  spf_result text,
  dkim_result text,
  body_preview text,
  processed_ms int,
  created_at timestamptz not null default now()
);
create unique index if not exists inbound_emails_message_id_idx on inbound_emails (message_id) where message_id is not null;
create index if not exists inbound_emails_dedupe_idx on inbound_emails (dedupe_hash, created_at desc);
create index if not exists inbound_emails_created_idx on inbound_emails (created_at desc);

alter table inbound_emails enable row level security;
drop policy if exists staff_inbound_emails on inbound_emails;
create policy staff_inbound_emails on inbound_emails for select using (is_staff());
-- no insert/update/delete policy: only the service role writes the log
