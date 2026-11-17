-- Card authorization hold, decoupled from the non-return fee.
-- $12/bank is authorized at checkout; usage above the hold settles off-session
-- at return (same saved-card pattern as the non-return fee, which stays separate).
-- NULL-safe fallback in pricingFromRow keeps pre-existing rows working: they
-- resolve to non_return_max_cents, matching the hold that was actually placed.
alter table pricing_versions
  add column if not exists hold_cents int;

-- The version created by 0078 predates this column; it gets the new $12 hold.
-- Older versions stay NULL → non_return_max_cents fallback, matching the
-- authorization that was actually placed on those rentals.
update pricing_versions set hold_cents = 1200 where id = 'pilot-2026-v2' and hold_cents is null;

-- New ledger kind: rental charges that exceed the smaller $12 hold settle as a
-- separate off-session "rental_overage" entry alongside the hold capture.
alter table billing_ledger drop constraint if exists billing_ledger_kind_check;
alter table billing_ledger add constraint billing_ledger_kind_check
  check (kind in ('rental_charge','non_return_fee','refund','adjustment','rental_overage'));
