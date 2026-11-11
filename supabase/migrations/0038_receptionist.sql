-- Migration 0038 — AI receptionist (general-correspondence desk for hello@zapnivo.com).
-- Separate from helpdesk tickets: threads + messages + audit events for mail routed
-- by the inbound worker when a recipient matches GENERAL_INBOX. Staff get full RLS
-- access; customers get NO direct access (all reads/writes go through the service role).
-- message_id + partial unique index give provider-redelivery dedupe on messages.

create table if not exists receptionist_threads (
  id uuid primary key default gen_random_uuid(),
  sender_email citext not null,
  subject text not null default '',
  category text not null default 'unknown'
    check (category in ('general','venue_inquiry','advertising','enterprise','event_charging','press','vendor','customer_support','billing','refund','security','legal','employment','spam','unknown')),
  status text not null default 'new'
    check (status in ('new','ai_reviewing','draft_ready','awaiting_approval','assigned','waiting','resolved','quarantined','archived')),
  priority text not null default 'normal'
    check (priority in ('low','normal','high','urgent')),
  autonomy_level int not null default 1 check (autonomy_level between 0 and 2),
  assigned_to uuid,
  ai_confidence numeric,
  escalation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index if not exists receptionist_threads_sender_idx on receptionist_threads (sender_email);
create index if not exists receptionist_threads_status_idx on receptionist_threads (status);
create index if not exists receptionist_threads_last_msg_idx on receptionist_threads (last_message_at desc);

create table if not exists receptionist_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references receptionist_threads(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound','draft','internal')),
  message_id text,
  from_addr text,
  to_addr text,
  subject text,
  body_text text not null default '',
  body_html text,
  sender_kind text not null default 'customer'
    check (sender_kind in ('customer','ai','staff','system')),
  created_at timestamptz not null default now()
);
create index if not exists receptionist_messages_thread_idx on receptionist_messages (thread_id, created_at);
create unique index if not exists receptionist_messages_msgid_idx on receptionist_messages (message_id) where message_id is not null;

create table if not exists receptionist_audit_events (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references receptionist_threads(id) on delete cascade,
  actor text not null default 'system',
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists receptionist_audit_thread_idx on receptionist_audit_events (thread_id, created_at desc);

alter table receptionist_threads enable row level security;
alter table receptionist_messages enable row level security;
alter table receptionist_audit_events enable row level security;

drop policy if exists staff_receptionist_threads on receptionist_threads;
create policy staff_receptionist_threads on receptionist_threads for all using (is_staff()) with check (is_staff());
drop policy if exists staff_receptionist_messages on receptionist_messages;
create policy staff_receptionist_messages on receptionist_messages for all using (is_staff()) with check (is_staff());
drop policy if exists staff_receptionist_audit on receptionist_audit_events;
create policy staff_receptionist_audit on receptionist_audit_events for all using (is_staff()) with check (is_staff());
-- no customer-facing policies: general-correspondence mail is staff-only.
