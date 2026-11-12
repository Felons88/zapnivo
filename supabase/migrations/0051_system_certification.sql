-- Migration 0051 — kiosk hardware certification run ledger.
--
-- Phase 2.4 hardware certification console (system.zapnivo.com →
-- Kiosk Infrastructure → Certification). Backs
-- src/app/api/system/kiosks/certification + /system/kiosks/certification.
--
-- Each row records ONE check result for ONE tier:
--   simulated        — software-contract checks (tests/hardware-certification.test.ts C1–C14,
--                      kiosk simulator). NEVER claims physical verification.
--   gateway_contract — gateway message-schema / idempotency / ack-correlation checks.
--   physical         — real-hardware checks (dispense/return acks, fault injection).
--                      Recording one requires a live step-up elevation (route-enforced).
--
-- Tamper evidence (computed app-side at insert, sha256 over canonical JSON):
--   prev_hash    — record_hash of the previous run in the SAME chain
--                  (device_id + tier; NULL device_id = fleet-level chain).
--                  First run in a chain has prev_hash NULL.
--   record_hash  — sha256(canonicalJson({device_id,tier,check_key,status,detail,
--                  actor_id,prev_hash,created_at})). Any later edit to a stored
--                  row breaks recomputation; deleting a row breaks the next
--                  row's prev_hash linkage. verifyCertificationChain()
--                  (src/app/api/system/kiosks/certification/route.ts) re-checks both.
--
-- HONEST LIMIT: this is application-level tamper EVIDENCE, not append-only
-- enforcement — the service role can still UPDATE/DELETE. RLS below grants
-- SELECT only to system users; all writes go through the service role after
-- permission + (for 'physical') step-up elevation checks. A DB-level
-- append-only guarantee (revoke UPDATE/DELETE from service_role, or a
-- trigger rejecting mutation) would be stronger and is a reasonable
-- follow-up once the table stabilizes.

create table if not exists system_certification_runs (
  id uuid primary key default gen_random_uuid(),
  device_id uuid references system_devices(id) on delete set null,
  tier text not null check (tier in ('simulated','gateway_contract','physical')),
  check_key text not null check (check_key ~ '^[a-z0-9][a-z0-9_.-]{0,79}$'),
  status text not null check (status in ('pass','fail','blocked','skipped')),
  detail jsonb,
  actor_id uuid,
  created_at timestamptz not null default now(),
  record_hash text not null,
  prev_hash text
);

comment on table system_certification_runs is
  'Append-only certification run ledger. record_hash/prev_hash form a per-(device_id,tier) hash chain for tamper evidence. Simulated/gateway results are NOT physical hardware verification.';
comment on column system_certification_runs.record_hash is
  'sha256 of canonical JSON of the row content (incl. prev_hash). Computed server-side at insert; recomputed by verifyCertificationChain for tamper checks.';
comment on column system_certification_runs.prev_hash is
  'record_hash of the previous run in the same device_id+tier chain; NULL for the first run.';

create index if not exists system_certification_runs_device_tier_idx
  on system_certification_runs (device_id, tier, created_at desc);
create index if not exists system_certification_runs_created_idx
  on system_certification_runs (created_at desc);

alter table system_certification_runs enable row level security;

-- SELECT-only for system-console users (has_system_access() from 0043).
-- NO insert/update/delete policies: writes are service-role only via the
-- permission + elevation-gated API route.
drop policy if exists system_staff_certification on system_certification_runs;
create policy system_staff_certification on system_certification_runs
  for select using (has_system_access());
