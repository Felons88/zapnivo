-- Migration 0017 — customer privacy: SMS preference + export/deletion request queue.
-- customers.profiles.notify_sms: account-level SMS toggle (per-rental sms_consent in 0013 still applies).
-- customer_data_requests: audit/queue for GDPR-style export & deletion requests. Customers never
-- read this table directly; staff read via RLS, all writes go through the service role.

alter table profiles add column if not exists notify_sms boolean not null default false;

create table if not exists customer_data_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete set null,
  email citext not null,
  kind text not null check (kind in ('export','deletion')),
  status text not null default 'pending' check (status in ('pending','processed','cancelled')),
  note text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  processed_by uuid references profiles(id) on delete set null
);
create index if not exists customer_data_requests_user_idx on customer_data_requests (user_id, created_at desc);
create index if not exists customer_data_requests_pending_idx on customer_data_requests (status, created_at) where status = 'pending';

alter table customer_data_requests enable row level security;
drop policy if exists staff_read_customer_requests on customer_data_requests;
create policy staff_read_customer_requests on customer_data_requests for select using (is_staff());
