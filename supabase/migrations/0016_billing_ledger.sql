-- Migration 0016 — append-only billing ledger.
-- Every capture / fee / refund writes one row; amount_cents never changes after insert
-- (signed: charges positive, refunds negative). status may transition pending -> succeeded/failed.
-- idempotency_key is UNIQUE so a retried write can never double-post.

create table if not exists billing_ledger (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references rentals(id) on delete cascade,
  kind text not null check (kind in ('rental_charge','non_return_fee','refund','adjustment')),
  amount_cents int not null,
  stripe_payment_intent_id text,
  stripe_charge_id text,
  status text not null default 'pending' check (status in ('pending','succeeded','failed','refunded','cancelled')),
  idempotency_key text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists billing_ledger_rental_idx on billing_ledger (rental_id, kind);
create index if not exists billing_ledger_pi_idx on billing_ledger (stripe_payment_intent_id);

alter table billing_ledger enable row level security;
drop policy if exists staff_billing_ledger on billing_ledger;
create policy staff_billing_ledger on billing_ledger for select using (is_staff());
-- no insert/update/delete policy: only the service role writes the ledger
