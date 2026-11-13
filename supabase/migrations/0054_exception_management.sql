-- Migration 0054 — rental_exceptions lifecycle management (Phase 2.6).
--
-- rental_exceptions (0050) started as a minimal investigation ledger: status was
-- a 4-value CHECK ('open','investigating','resolved','dismissed') with no
-- assignee, notes, or timestamps beyond created_at/resolved_at. The system
-- console now manages these exceptions (src/lib/system/exceptions.ts), so the
-- table gains the workflow columns that state machine needs.
--
-- Backward compatibility:
--   * 'open' stays a VALID status value (existing rows + kiosk writers keep
--     working). The lib maps 'open' → canonical state 'new' on read; new writes
--     use the canonical vocabulary below.
--   * 'dismissed' stays valid as a legacy terminal state (no outgoing edges).
--   * kind remains free-text (0050/0052 documented choice) — new kinds need no
--     migration.
--
-- State vocabulary (canonical; enforced in src/lib/system/exceptions.ts):
--   new → investigating → awaiting_device | awaiting_support |
--         requires_financial_review → resolved → reopened (reason required)
-- 'requires_financial_review' is INFORMATIONAL: resolving the exception record
-- never moves money — financial discrepancies stay owned by fin_cases (0039).

-- 1) Widen the status CHECK. Legacy 'open'/'dismissed' remain valid; the
--    canonical workflow states are added.
alter table rental_exceptions drop constraint if exists rental_exceptions_status_check;
alter table rental_exceptions
  add constraint rental_exceptions_status_check
  check (status in (
    'open', 'dismissed',                                   -- legacy values (0050)
    'new', 'investigating',
    'awaiting_device', 'awaiting_support',
    'requires_financial_review',
    'resolved', 'reopened'
  ));

-- 2) Assignment + resolution bookkeeping.
alter table rental_exceptions
  add column if not exists assigned_to uuid references profiles(id) on delete set null;
alter table rental_exceptions
  add column if not exists resolution_notes text;
alter table rental_exceptions
  add column if not exists notes jsonb not null default '[]'::jsonb;   -- [{at,by,text}] investigation thread
alter table rental_exceptions
  add column if not exists updated_at timestamptz not null default now();
alter table rental_exceptions
  add column if not exists reopened_count int not null default 0;

-- Backfill: pre-0054 rows get honest timestamps (created_at is the only truth).
-- (The ADD COLUMN default already filled updated_at with migration time — reset it.)
update rental_exceptions set updated_at = created_at;
update rental_exceptions set resolved_at = created_at
  where status = 'resolved' and resolved_at is null;

-- 3) Lookup indexes for the console filters.
create index if not exists rental_exceptions_assigned_idx
  on rental_exceptions (assigned_to, created_at desc) where assigned_to is not null;
create index if not exists rental_exceptions_active_idx
  on rental_exceptions (status, created_at desc)
  where status not in ('resolved', 'dismissed');

-- RLS unchanged: staff read (0050 policy), writes only via service role.
