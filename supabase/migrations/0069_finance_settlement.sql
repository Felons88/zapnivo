-- 0069_finance_settlement.sql
-- Phase 6: auditable partner settlement + admin finance assumptions.
-- payout_records gains approval trail + external payment reference;
-- admin_finance_assumptions stores editable unit-economics inputs
-- (hardware/install/connectivity costs, software allocation) kept strictly
-- separate from financial transaction tables.

-- ─── payout_records: settlement workflow columns ─────────────────────────────
alter table payout_records
  add column if not exists method text,                 -- 'ach' | 'check' | 'other' — recorded, never executed by the app
  add column if not exists provider_reference text,     -- external payout/transfer reference entered by staff after paying outside the app
  add column if not exists approved_by uuid references profiles(id),
  add column if not exists approved_at timestamptz,
  add column if not exists notes text;

-- widen the status check: scheduled → approved → paid|failed|cancelled
alter table payout_records drop constraint if exists payout_records_status_check;
alter table payout_records
  add constraint payout_records_status_check
  check (status in ('scheduled','approved','paid','failed','cancelled'));

create index if not exists payout_records_status_idx on payout_records(status);

-- ─── admin_finance_assumptions: editable non-transactional assumptions ────────
-- One row per assumption key. Values are numbers (cents or counts) or short
-- strings; admins edit via /admin/profitability. Never used as financial truth —
-- every consumer must label output "assumption-based".
create table if not exists admin_finance_assumptions (
  key text primary key,
  value jsonb not null,
  label text not null,
  unit text,                        -- 'usd_cents' | 'usd' | 'count' | 'text'
  description text,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);

alter table admin_finance_assumptions enable row level security;
-- service-role writes only (all access goes through server routes); staff read.
drop policy if exists staff_finance_assumptions on admin_finance_assumptions;
create policy staff_finance_assumptions on admin_finance_assumptions
  for select using (is_staff());

-- Seed sensible zero/blank defaults so the UI always has rows to edit.
insert into admin_finance_assumptions (key, value, label, unit, description) values
  ('kiosk.hardware_cost_cents',      '0'::jsonb,  'Hardware purchase cost',        'usd_cents', 'Per-kiosk hardware cost (owner-entered)'),
  ('kiosk.install_cost_cents',       '0'::jsonb,  'Installation cost',             'usd_cents', 'Per-kiosk installation/commissioning'),
  ('kiosk.connectivity_cost_cents',  '0'::jsonb,  'Connectivity cost / month',     'usd_cents', 'Per-kiosk monthly connectivity'),
  ('kiosk.software_alloc_cents',     '0'::jsonb,  'Software allocation / month',   'usd_cents', 'Per-kiosk monthly software allocation'),
  ('kiosk.bank_cost_cents',          '0'::jsonb,  'Replacement power bank cost',   'usd_cents', 'Per-bank hardware cost for wear replacement'),
  ('kiosk.maintenance_cost_cents',   '0'::jsonb,  'Maintenance cost / month',      'usd_cents', 'Per-kiosk monthly maintenance reserve'),
  ('placement.foot_traffic_index',   '"unknown"'::jsonb, 'Foot-traffic data source','text',      'How venue traffic estimates are sourced (e.g. owner_estimate, third_party)')
  on conflict (key) do nothing;
