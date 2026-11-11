-- Migration 0039 — Financial investigations department.
--
-- fin_cases: one row per financial investigation (duplicate charge, failed dispense,
-- missing telemetry, credit dispute, fraud review...). Human staff own every decision;
-- `recommendation` is advisory only — nothing here can move money.
-- fin_case_events: append-only audit trail for the case (who did what, when).
--
-- Refund execution stays exclusively in the existing staff refund route
-- (src/app/api/admin/payments/[id]/refund). A case reaching decision='approved' only
-- means a human approved the *action*; staff still issue the refund through that route.

create table if not exists fin_cases (
  id uuid primary key default gen_random_uuid(),
  case_type text not null,
  status text not null default 'new',
  severity text not null default 'normal',
  customer_ref text,
  rental_id uuid references rentals(id) on delete set null,
  payment_id uuid references payments(id) on delete set null,
  station_id text,
  claimed_amount_cents int check (claimed_amount_cents is null or claimed_amount_cents >= 0),
  subject text not null,
  description text not null default '',
  assigned_to uuid references profiles(id) on delete set null,
  evidence jsonb not null default '{}'::jsonb,       -- last collected dossier
  recommendation jsonb,                              -- advisory only, never auto-applied
  decision text check (decision is null or decision in ('approved','denied')),
  decision_rationale text,
  decided_by uuid references profiles(id) on delete set null,
  decided_at timestamptz,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists fin_cases_status_idx on fin_cases (status);
create index if not exists fin_cases_type_idx on fin_cases (case_type);
create index if not exists fin_cases_rental_idx on fin_cases (rental_id);
create index if not exists fin_cases_payment_idx on fin_cases (payment_id);
create index if not exists fin_cases_created_idx on fin_cases (created_at desc);

create table if not exists fin_case_events (
  id bigint generated always as identity primary key,
  case_id uuid not null references fin_cases(id) on delete cascade,
  actor text,                                        -- staff uuid, 'system', or 'agent:<id>' label
  action text not null,                              -- created|assigned|status|evidence_collected|recommendation|decided|note
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists fin_case_events_case_idx on fin_case_events (case_id, created_at);

alter table fin_cases enable row level security;
alter table fin_case_events enable row level security;

-- Staff-only, all operations (same posture as monetization tables, migration 0031).
drop policy if exists staff_fin_cases on fin_cases;
create policy staff_fin_cases on fin_cases for all using (is_staff());
drop policy if exists staff_fin_case_events on fin_case_events;
create policy staff_fin_case_events on fin_case_events for all using (is_staff());
