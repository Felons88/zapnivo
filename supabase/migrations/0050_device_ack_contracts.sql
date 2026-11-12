-- Migration 0050 — rental_exceptions: investigation records for ambiguous
-- device acknowledgement / reconciliation events (Phase 2.4).
--
-- Written by src/lib/kiosk/lifecycle.ts (raiseException) when an authenticated
-- kiosk ack cannot be honestly reconciled: unknown command_id, rental_ref
-- mismatch, bank mismatch, no matching rental, illegal dispense transition, or
-- a dispense ack against a terminal/fee rental state.
--
-- Why a dedicated table (documented choice):
--   * fin_cases (0039) is the FINANCE investigation workflow — human-approved
--     money decisions with claimed_amount/decision semantics. An ack anomaly is
--     not a money decision.
--   * incidents (0026) is service-level ops (uptime/cron/error spikes) with no
--     rental/kiosk foreign keys — wrong granularity for per-rental reconciliation.
--   * support_tickets is customer-facing helpdesk — these exceptions are
--     staff-internal until a human decides customer contact is needed.
--
-- Acks NEVER auto-settle: this table only records that a human should look.

create table if not exists rental_exceptions (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid references rentals(id) on delete set null,   -- null when no rental resolved
  kiosk_id uuid references kiosks(id) on delete set null,
  kind text not null,          -- unknown_command | rental_ref_mismatch | bank_mismatch | no_matching_rental | illegal_transition | unexpected_rental_state
  detail jsonb not null default '{}'::jsonb,                  -- event_id, command_id, refs, error_code, simulated flag
  status text not null default 'open' check (status in ('open','investigating','resolved','dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists rental_exceptions_status_idx on rental_exceptions (status, created_at desc);
create index if not exists rental_exceptions_kind_idx on rental_exceptions (kind, created_at desc);
create index if not exists rental_exceptions_rental_idx on rental_exceptions (rental_id) where rental_id is not null;
create index if not exists rental_exceptions_kiosk_idx on rental_exceptions (kiosk_id, created_at desc);

-- RLS: staff read; writes only via service role (same posture as kiosk_events, 0015).
alter table rental_exceptions enable row level security;
drop policy if exists staff_read_rental_exceptions on rental_exceptions;
create policy staff_read_rental_exceptions on rental_exceptions for select using (is_staff());
