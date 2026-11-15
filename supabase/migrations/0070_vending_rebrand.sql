-- 0070_vending_rebrand.sql
-- Phase: Zapnivo Vending Services rebrand.
-- Generalizes the partner/venue model beyond charger kiosks and captures
-- vending-machine placement + equipment-sales interest on the existing
-- partner_applications CRM pipeline (no duplicate CRM).

-- ─── partner_applications: vending lead capture ──────────────────────────────
alter table partner_applications
  add column if not exists product_interest text,   -- vending category key(s), e.g. 'snack','beverage','charger_station','trading_cards','specialty','custom'
  add column if not exists space_notes text,        -- available space / placement details
  add column if not exists timeline text;           -- preferred installation timeline

-- ─── equipment classification ────────────────────────────────────────────────
-- Nullable on purpose: NULL means "not classified" — existing charger kiosks
-- keep working unchanged and are treated as charger_station by readers.
alter table venues  add column if not exists equipment_category text;
alter table kiosks  add column if not exists equipment_category text;

create index if not exists venues_equipment_category_idx on venues(equipment_category);
create index if not exists kiosks_equipment_category_idx on kiosks(equipment_category);

-- ─── vending inquiry leads reuse partner_applications; widen status flow ─────
-- 'new' → 'reviewed' → 'consultation' → 'approved' → 'installed' already fits
-- placement requests; 'declined' covers unsuitable locations. No enum change.
