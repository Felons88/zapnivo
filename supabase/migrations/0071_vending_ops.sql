-- 0071_vending_ops.sql
-- Phase 7: vending business operations.
-- Equipment catalog + physical units (charger units link to existing kiosks —
-- no duplicate device identity), placement pipeline extensions on
-- partner_applications, venue suitability assessments, product inventory +
-- restocking workflow, effective-dated equipment agreements, partner service
-- requests. All staff-facing tables are service-role-write / staff-read RLS;
-- partners read only their own org's equipment and file service requests.

-- ─── Equipment catalog (models) vs physical units ────────────────────────────
create table if not exists equipment_models (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('charger_station','snack','beverage','food','trading_cards','specialty','combo')),
  manufacturer text,
  model_name text not null,
  capacity_description text,
  dimensions text,
  acquisition_cost_cents int check (acquisition_cost_cents is null or acquisition_cost_cents >= 0),
  supplier text,
  warranty_months int check (warranty_months is null or warranty_months >= 0),
  connectivity text,                     -- free text: cashless/telemetry/cellular etc, honest notes only
  status text not null default 'draft' check (status in ('draft','active','discontinued')),
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists equipment_units (
  id uuid primary key default gen_random_uuid(),
  model_id uuid references equipment_models(id) on delete set null,
  serial_number text unique,
  category text not null check (category in ('charger_station','snack','beverage','food','trading_cards','specialty','combo')),
  -- Lifecycle: planned → sourcing → ordered → received → inspected → available
  -- → assigned → installed → active → maintenance → retired
  status text not null default 'planned' check (status in
    ('planned','sourcing','ordered','received','inspected','available','assigned',
     'installed','active','maintenance','retired')),
  kiosk_id uuid references kiosks(id) on delete set null,   -- charger units reuse the device record
  venue_id uuid references venues(id) on delete set null,   -- assigned venue (null = unassigned/warehouse)
  ownership text not null default 'company' check (ownership in ('company','venue','leased','customer')),
  cost_cents int check (cost_cents is null or cost_cents >= 0),  -- actual acquisition cost when known; overrides model estimate for payback math
  manufacturer text,                                        -- denormalized display copy (no invented specs)
  model_label text,
  service_schedule text,
  installed_at timestamptz,
  retired_at timestamptz,
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists equipment_units_status_idx on equipment_units(status);
create index if not exists equipment_units_venue_idx on equipment_units(venue_id);
create index if not exists equipment_units_category_idx on equipment_units(category);
create index if not exists equipment_units_kiosk_idx on equipment_units(kiosk_id);

-- Lifecycle transition audit (append-only)
create table if not exists equipment_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references equipment_units(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor uuid references profiles(id),
  note text,
  created_at timestamptz not null default now()
);
create index if not exists equipment_lifecycle_unit_idx on equipment_lifecycle_events(unit_id);

-- ─── Placement pipeline (extends partner_applications) ───────────────────────
alter table partner_applications
  add column if not exists placement_stage text not null default 'inquiry'
    check (placement_stage in ('inquiry','qualified','contacted','site_survey',
      'equipment_recommendation','proposal','negotiation','agreement_pending',
      'approved','sourcing','install_scheduled','installed','active','declined')),
  add column if not exists assigned_to uuid references profiles(id),
  add column if not exists follow_up_at timestamptz,
  add column if not exists next_action text;

create index if not exists partner_applications_stage_idx on partner_applications(placement_stage);

create table if not exists placement_activities (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references partner_applications(id) on delete cascade,
  actor uuid references profiles(id),
  kind text not null default 'note' check (kind in ('note','stage_change','call','email','meeting','document')),
  body text,
  created_at timestamptz not null default now()
);
create index if not exists placement_activities_app_idx on placement_activities(application_id);

create table if not exists venue_assessments (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references partner_applications(id) on delete cascade,
  venue_id uuid references venues(id) on delete cascade,
  traffic_estimate text,
  electrical_availability text,
  floor_space text,
  accessibility text,
  indoor_outdoor text,
  product_preferences text,
  maintenance_access text,
  equipment_category text,
  constraints text,
  notes text,
  assessed_by uuid references profiles(id),
  assessed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists venue_assessments_app_idx on venue_assessments(application_id);
create index if not exists venue_assessments_venue_idx on venue_assessments(venue_id);

-- ─── Product inventory ───────────────────────────────────────────────────────
create table if not exists product_skus (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('snack','beverage','food','trading_cards','collectibles','specialty')),
  name text not null,
  supplier text,
  unit_cost_cents int check (unit_cost_cents is null or unit_cost_cents >= 0),
  reorder_point int not null default 0 check (reorder_point >= 0),
  track_expiry boolean not null default false,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Stock lives in exactly one place: warehouse (both ids null), a unit, or a venue.
create table if not exists stock_levels (
  id uuid primary key default gen_random_uuid(),
  sku_id uuid not null references product_skus(id) on delete cascade,
  unit_id uuid references equipment_units(id) on delete cascade,
  venue_id uuid references venues(id) on delete cascade,
  qty int not null default 0 check (qty >= 0),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (sku_id, unit_id, venue_id)
);
create index if not exists stock_levels_sku_idx on stock_levels(sku_id);
create index if not exists stock_levels_unit_idx on stock_levels(unit_id);

-- ─── Restocking workflow ─────────────────────────────────────────────────────
create table if not exists restock_visits (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references equipment_units(id) on delete cascade,
  technician uuid references profiles(id),
  status text not null default 'planned' check (status in ('planned','in_progress','completed','cancelled')),
  scheduled_for timestamptz,
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists restock_visits_unit_idx on restock_visits(unit_id);
create index if not exists restock_visits_status_idx on restock_visits(status);

create table if not exists restock_visit_lines (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references restock_visits(id) on delete cascade,
  sku_id uuid not null references product_skus(id),
  qty_picked int not null default 0 check (qty_picked >= 0),
  qty_loaded int not null default 0 check (qty_loaded >= 0),
  qty_waste int not null default 0 check (qty_waste >= 0),
  created_at timestamptz not null default now(),
  unique (visit_id, sku_id)
);

-- ─── Equipment agreements (effective-dated versions) ─────────────────────────
create table if not exists equipment_agreements (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  organization_id uuid references organizations(id) on delete set null,
  equipment_category text not null,
  version int not null default 1,
  status text not null default 'draft' check (status in ('draft','active','superseded','terminated')),
  effective_from date,
  effective_to date,
  revenue_share_pct numeric(5,2) check (revenue_share_pct is null or (revenue_share_pct >= 0 and revenue_share_pct <= 100)),
  terms jsonb not null default '{}'::jsonb,
  approved_by uuid references profiles(id),
  approved_at timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  unique (venue_id, equipment_category, version)
);
create index if not exists equipment_agreements_venue_idx on equipment_agreements(venue_id);
create index if not exists equipment_agreements_org_idx on equipment_agreements(organization_id);

-- ─── Partner service requests ────────────────────────────────────────────────
create table if not exists service_requests (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  unit_id uuid references equipment_units(id) on delete set null,
  category text not null default 'general',
  description text not null,
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'new' check (status in ('new','acknowledged','scheduled','completed','cancelled'))
    ,
  requested_by uuid references profiles(id),
  assigned_to uuid references profiles(id),
  resolved_at timestamptz,
  resolution_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists service_requests_venue_idx on service_requests(venue_id);
create index if not exists service_requests_status_idx on service_requests(status);

-- ─── RLS: staff manage; partners read own-org equipment + file requests ──────
alter table equipment_models enable row level security;
alter table equipment_units enable row level security;
alter table equipment_lifecycle_events enable row level security;
alter table placement_activities enable row level security;
alter table venue_assessments enable row level security;
alter table product_skus enable row level security;
alter table stock_levels enable row level security;
alter table restock_visits enable row level security;
alter table restock_visit_lines enable row level security;
alter table equipment_agreements enable row level security;
alter table service_requests enable row level security;

-- staff full access via service role; staff read for authenticated staff
create policy staff_rw_models on equipment_models for all using (is_staff()) with check (is_staff());
create policy staff_rw_units on equipment_units for all using (is_staff()) with check (is_staff());
create policy staff_rw_lifecycle on equipment_lifecycle_events for all using (is_staff()) with check (is_staff());
create policy staff_rw_activities on placement_activities for all using (is_staff()) with check (is_staff());
create policy staff_rw_assessments on venue_assessments for all using (is_staff()) with check (is_staff());
create policy staff_rw_skus on product_skus for all using (is_staff()) with check (is_staff());
create policy staff_rw_stock on stock_levels for all using (is_staff()) with check (is_staff());
create policy staff_rw_restock on restock_visits for all using (is_staff()) with check (is_staff());
create policy staff_rw_restock_lines on restock_visit_lines for all using (is_staff()) with check (is_staff());
create policy staff_rw_agreements on equipment_agreements for all using (is_staff()) with check (is_staff());

-- partner read: equipment at their org's venues; agreements for their org
create policy partner_read_units on equipment_units for select using (
  venue_id in (select id from venues where organization_id = (select organization_id from profiles where id = auth.uid()))
);
create policy partner_read_agreements on equipment_agreements for select using (
  organization_id = (select organization_id from profiles where id = auth.uid())
  or venue_id in (select id from venues where organization_id = (select organization_id from profiles where id = auth.uid()))
);
-- partner service requests: read own org's, insert for own org's venues
create policy partner_read_requests on service_requests for select using (
  venue_id in (select id from venues where organization_id = (select organization_id from profiles where id = auth.uid()))
);
create policy partner_insert_requests on service_requests for insert with check (
  venue_id in (select id from venues where organization_id = (select organization_id from profiles where id = auth.uid()))
);
create policy staff_rw_requests on service_requests for all using (is_staff()) with check (is_staff());
