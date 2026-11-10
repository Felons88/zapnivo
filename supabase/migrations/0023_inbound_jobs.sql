-- Migration 0023 — durable inbound email job queue + realtime publication.
--
-- Stage A (webhook): validates + persists each parsed inbound email as a job
-- and acks Brevo immediately. Stage B (worker, /api/cron/inbound): claims jobs
-- with a conditional status update (safe under concurrent workers), runs the
-- ticket-matching pipeline, retries with exponential backoff, dead-letters
-- after MAX_ATTEMPTS, and recovers jobs stuck in 'processing'.
--
-- support_messages / support_tickets join the supabase_realtime publication so
-- staff, partner, and (where RLS permits) customer clients can subscribe.
-- RLS is unchanged — realtime inherits existing SELECT policies.

create table if not exists inbound_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'email_message',
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued','processing','done','failed','dead')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  run_after timestamptz not null default now(),
  claimed_at timestamptz,
  message_id text,
  dedupe_hash text,
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create unique index if not exists inbound_jobs_message_id_idx on inbound_jobs (message_id) where message_id is not null;
create index if not exists inbound_jobs_dedupe_idx on inbound_jobs (dedupe_hash, created_at desc);
create index if not exists inbound_jobs_claim_idx on inbound_jobs (status, run_after, created_at);
create index if not exists inbound_jobs_created_idx on inbound_jobs (created_at desc);

alter table inbound_jobs enable row level security;
drop policy if exists staff_inbound_jobs on inbound_jobs;
create policy staff_inbound_jobs on inbound_jobs for select using (is_staff());
-- no insert/update/delete policies: only the service role writes the queue

do $$
begin
  begin
    execute 'alter publication supabase_realtime add table support_messages';
  exception when others then null;
  end;
  begin
    execute 'alter publication supabase_realtime add table support_tickets';
  exception when others then null;
  end;
end $$;
