-- Zapnivo core schema — migration 0001
-- Apply with: supabase db push  (or paste into the SQL editor for the initial project)
-- Roles: admin (full staff), staff (ops), partner (venue), customer (future rental users)

create extension if not exists pgcrypto;
create extension if not exists citext;
create domain month as date check (date_trunc('month', value) = value);

-- ─── Enums ───────────────────────────────────────────────────────────────────
create type user_role as enum ('admin', 'staff', 'partner', 'customer');
create type kiosk_state as enum ('provisioning', 'online', 'offline', 'maintenance', 'disabled');
create type slot_state as enum ('empty', 'charging', 'ready', 'fault');
create type rental_state as enum ('authorized', 'dispense_pending', 'active', 'returned', 'unreturned', 'cancelled', 'charged_off');
create type payment_state as enum ('authorized', 'captured', 'partially_refunded', 'refunded', 'failed', 'released');
create type ticket_state as enum ('open', 'pending_customer', 'pending_internal', 'resolved', 'closed');
create type ticket_priority as enum ('low', 'normal', 'high', 'urgent');
create type application_state as enum ('new', 'reviewed', 'consultation', 'approved', 'declined', 'installed');

-- ─── Identity ────────────────────────────────────────────────────────────────
create table organizations (                          -- venue companies / partners
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table profiles (                                 -- extends auth.users
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role user_role not null default 'customer',
  organization_id uuid references organizations(id) on delete set null,
  mfa_required boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

create or replace function my_role() returns user_role
language sql stable security definer set search_path = public as
$$ select role from public.profiles where id = auth.uid() $$;

create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as
$$ select my_role() in ('admin','staff') $$;

-- ─── Venues & hardware ───────────────────────────────────────────────────────
create table venues (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete set null,
  name text not null,
  venue_type text not null,
  street text not null, city text not null, state char(2) not null, zip varchar(10),
  hours text, lat numeric(9,6), lng numeric(9,6),
  published boolean not null default false,          -- only true once verified live
  created_at timestamptz not null default now()
);
create index venues_org_idx on venues (organization_id);

create table venue_contacts (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  user_id uuid references profiles(id) on delete set null,
  name text not null, email text not null, phone text,
  authorized boolean not null default false
);

create table kiosks (
  id uuid primary key default gen_random_uuid(),
  station_id text not null unique,                   -- server-generated, used in QR codes
  venue_id uuid references venues(id) on delete set null,
  state kiosk_state not null default 'provisioning',
  model text, firmware_version text,
  last_seen_at timestamptz, installed_at timestamptz,
  slot_count int not null default 8 check (slot_count > 0),
  created_at timestamptz not null default now()
);

create table kiosk_slots (
  kiosk_id uuid not null references kiosks(id) on delete cascade,
  slot_number int not null,
  state slot_state not null default 'empty'::slot_state,
  power_bank_id uuid,
  primary key (kiosk_id, slot_number)
);

create table power_banks (
  id uuid primary key default gen_random_uuid(),
  serial text not null unique,
  battery_pct smallint check (battery_pct between 0 and 100),
  current_kiosk uuid references kiosks(id) on delete set null,
  retired boolean not null default false,
  created_at timestamptz not null default now()
);
alter table kiosk_slots add constraint fk_slot_bank foreign key (power_bank_id) references power_banks(id) on delete set null;

create table device_events (                          -- immutable hardware event log
  id bigint generated always as identity primary key,
  kiosk_id uuid not null references kiosks(id) on delete cascade,
  slot_number int, power_bank_id uuid references power_banks(id),
  event_type text not null, payload jsonb,
  occurred_at timestamptz not null default now()
);
create index device_events_kiosk_idx on device_events (kiosk_id, occurred_at desc);

create table device_commands (                        -- idempotent outbound commands
  id uuid primary key default gen_random_uuid(),
  kiosk_id uuid not null references kiosks(id),
  command text not null,
  idempotency_key text not null unique,              -- UNIQUE prevents duplicate dispenses
  issued_by uuid references profiles(id),
  status text not null default 'queued' check (status in ('queued','sent','acknowledged','failed','expired')),
  payload jsonb, created_at timestamptz not null default now(), resolved_at timestamptz
);

create table maintenance_visits (
  id uuid primary key default gen_random_uuid(),
  kiosk_id uuid not null references kiosks(id),
  technician uuid references profiles(id),
  notes text, visited_at timestamptz not null default now()
);

-- ─── Rentals & payments ─────────────────────────────────────────────────────
create table pricing_versions (
  id text primary key,                               -- e.g. 'pilot-2026-v1'
  approved boolean not null default false,
  first_hour_cents int not null, additional_hour_cents int not null,
  first_24h_cap_cents int not null, additional_day_cents int,   -- null until finalised
  non_return_max_cents int not null, non_return_after_hours int not null,
  effective_at timestamptz, created_at timestamptz not null default now()
);

create table rentals (
  id uuid primary key default gen_random_uuid(),
  renter_profile uuid references profiles(id),       -- nullable until accounts exist
  kiosk_id uuid not null references kiosks(id),
  power_bank_id uuid references power_banks(id),
  return_kiosk_id uuid references kiosks(id),
  state rental_state not null default 'authorized',
  pricing_version text not null references pricing_versions(id),  -- price locked at rental time
  started_at timestamptz, dispensed_at timestamptz, returned_at timestamptz,
  non_return_deadline timestamptz,
  created_at timestamptz not null default now()
);
create index rentals_state_idx on rentals (state);
create index rentals_kiosk_idx on rentals (kiosk_id);

create table payments (
  id uuid primary key default gen_random_uuid(),
  rental_id uuid not null references rentals(id),
  stripe_payment_intent_id text unique,              -- server-side only
  state payment_state not null default 'authorized',
  amount_authorized_cents int, amount_captured_cents int, currency char(3) default 'usd',
  receipt_email text, created_at timestamptz not null default now(), captured_at timestamptz
);

create table refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id),
  amount_cents int not null check (amount_cents > 0),
  reason text, stripe_refund_id text unique,
  issued_by uuid references profiles(id), created_at timestamptz not null default now()
);

create table disputes (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id),
  stripe_dispute_id text unique, status text,
  opened_at timestamptz not null default now(), resolved_at timestamptz
);

-- ─── Partner operations ──────────────────────────────────────────────────────
create table partner_agreements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  venue_id uuid references venues(id),
  signed_at date, document_path text,                -- private storage bucket
  terms jsonb,                                       -- private: rates never public
  created_at timestamptz not null default now()
);

create table commission_ledgers (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id),
  period month not null,                              -- custom: first of month
  gross_cents int not null default 0, commission_cents int not null default 0,
  statement_path text, created_at timestamptz not null default now(),
  unique (venue_id, period)
);

create table payout_records (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references commission_ledgers(id),
  amount_cents int not null, status text not null default 'scheduled' check (status in ('scheduled','paid','failed')),
  paid_at timestamptz, created_at timestamptz not null default now()
);

-- ─── Intake forms ────────────────────────────────────────────────────────────
create table partner_applications (
  id uuid primary key default gen_random_uuid(),
  business_name text not null, contact_name text not null,
  email citext not null, phone text not null,
  venue_type text not null, street text not null, city text not null, state char(2) not null,
  hours text, guest_traffic text, install_location text, questions text,
  status application_state not null default 'new',
  created_at timestamptz not null default now()
);

create table advertising_inquiries (
  id uuid primary key default gen_random_uuid(),
  company_name text not null, contact_name text not null,
  email citext not null, phone text, goals text not null, budget text,
  state text not null default 'new', created_at timestamptz not null default now()
);

create table contact_messages (
  id uuid primary key default gen_random_uuid(),
  queue text not null check (queue in ('venue_partnerships','customer_support','general','advertising')),
  name text not null, email citext not null, message text not null,
  handled boolean not null default false, created_at timestamptz not null default now()
);

-- ─── Support ─────────────────────────────────────────────────────────────────
create sequence support_ticket_seq start 1000;

create table support_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_number text not null unique default ('Z-' || nextval('support_ticket_seq')),
  rental_id uuid references rentals(id),
  name text not null, email citext not null, phone text,
  rental_ref text, station_label text, category text not null,
  description text not null, attachment_path text,   -- private bucket 'ticket-attachments'
  consent_at timestamptz,
  state ticket_state not null default 'open',
  priority ticket_priority not null default 'normal',
  assigned_to uuid references profiles(id),
  created_at timestamptz not null default now(), resolved_at timestamptz
);
create index tickets_state_idx on support_tickets (state, priority);

create table support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_tickets(id) on delete cascade,
  author uuid references profiles(id),
  internal boolean not null default false,           -- internal notes never leave staff
  body text not null, created_at timestamptz not null default now()
);

-- ─── Advertising ─────────────────────────────────────────────────────────────
create table advertising_campaigns (
  id uuid primary key default gen_random_uuid(),
  advertiser text not null, name text not null,
  status text not null default 'draft' check (status in ('draft','pending_approval','approved','scheduled','live','paused','taken_down')),
  starts_at timestamptz, ends_at timestamptz, created_at timestamptz not null default now()
);

create table advertising_assets (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references advertising_campaigns(id) on delete cascade,
  storage_path text not null, approved boolean not null default false,
  approved_by uuid references profiles(id), created_at timestamptz not null default now()
);

create table playback_events (                        -- only truth that ads ran
  id bigint generated always as identity primary key,
  asset_id uuid not null references advertising_assets(id),
  kiosk_id uuid not null references kiosks(id),
  played_at timestamptz not null default now(), duration_ms int
);

-- ─── Audit & config ──────────────────────────────────────────────────────────
create table audit_logs (
  id bigint generated always as identity primary key,
  actor uuid references profiles(id),
  action text not null, entity text not null, entity_id text,
  detail jsonb, occurred_at timestamptz not null default now()
);

create table system_config (
  key text primary key, value jsonb not null, updated_at timestamptz not null default now()
);

-- ─── Row Level Security ──────────────────────────────────────────────────────
alter table profiles enable row level security;
alter table organizations enable row level security;
alter table venues enable row level security;
alter table venue_contacts enable row level security;
alter table kiosks enable row level security;
alter table kiosk_slots enable row level security;
alter table power_banks enable row level security;
alter table device_events enable row level security;
alter table device_commands enable row level security;
alter table maintenance_visits enable row level security;
alter table pricing_versions enable row level security;
alter table rentals enable row level security;
alter table payments enable row level security;
alter table refunds enable row level security;
alter table disputes enable row level security;
alter table partner_agreements enable row level security;
alter table commission_ledgers enable row level security;
alter table payout_records enable row level security;
alter table partner_applications enable row level security;
alter table advertising_inquiries enable row level security;
alter table contact_messages enable row level security;
alter table support_tickets enable row level security;
alter table support_messages enable row level security;
alter table advertising_campaigns enable row level security;
alter table advertising_assets enable row level security;
alter table playback_events enable row level security;
alter table audit_logs enable row level security;
alter table system_config enable row level security;

-- Staff read/write policies (service role bypasses RLS anyway; these govern logged-in JWTs)
create policy staff_all_profiles on profiles for all using (is_staff() or id = auth.uid());
create policy staff_all_orgs on organizations for all using (is_staff() or exists (select 1 from profiles p where p.id = auth.uid() and p.organization_id = organizations.id));
create policy venues_policy on venues for all using (is_staff() or organization_id = (select organization_id from profiles where id = auth.uid()));
create policy contacts_policy on venue_contacts for all using (is_staff() or exists (select 1 from venues v where v.id = venue_id and v.organization_id = (select organization_id from profiles where id = auth.uid())));
create policy staff_kiosks on kiosks for all using (is_staff() or venue_id in (select id from venues where organization_id = (select organization_id from profiles where id = auth.uid())));
create policy staff_slots on kiosk_slots for all using (is_staff() or kiosk_id in (select k.id from kiosks k join venues v on v.id = k.venue_id where v.organization_id = (select organization_id from profiles where id = auth.uid())));
create policy staff_banks on power_banks for all using (is_staff());
create policy staff_events on device_events for all using (is_staff());
create policy staff_commands on device_commands for all using (is_staff() and my_role() = 'admin');
create policy staff_maintenance on maintenance_visits for all using (is_staff());
create policy public_pricing on pricing_versions for select using (approved);          -- approved pricing is displayable
create policy staff_pricing on pricing_versions for all using (is_staff());
create policy staff_rentals on rentals for all using (is_staff());
create policy staff_payments on payments for all using (is_staff());                   -- customers read via receipt endpoints only
create policy staff_refunds on refunds for all using (is_staff());
create policy staff_disputes on disputes for all using (is_staff());
create policy agreements_policy on partner_agreements for all using (is_staff() or organization_id = (select organization_id from profiles where id = auth.uid()));
create policy ledgers_policy on commission_ledgers for all using (is_staff() or venue_id in (select id from venues where organization_id = (select organization_id from profiles where id = auth.uid())));
create policy payouts_policy on payout_records for select using (is_staff() or ledger_id in (select l.id from commission_ledgers l join venues v on v.id = l.venue_id where v.organization_id = (select organization_id from profiles where id = auth.uid())));
-- Intake tables: insert via service role only (API routes). Staff read.
create policy staff_apps on partner_applications for select using (is_staff());
create policy staff_apps_upd on partner_applications for update using (is_staff());
create policy staff_ads_inq on advertising_inquiries for all using (is_staff());
create policy staff_contact on contact_messages for all using (is_staff());
create policy staff_tickets on support_tickets for all using (is_staff());
create policy staff_messages on support_messages for all using (is_staff());
create policy staff_campaigns on advertising_campaigns for all using (is_staff());
create policy staff_assets on advertising_assets for all using (is_staff());
create policy staff_playback on playback_events for all using (is_staff());
create policy staff_audit on audit_logs for select using (is_staff());
create policy staff_config on system_config for all using (my_role() = 'admin');

-- ─── Storage buckets ─────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public) values
  ('ticket-attachments', 'ticket-attachments', false),
  ('agreements', 'agreements', false),
  ('ad-creatives', 'ad-creatives', false)
on conflict (id) do nothing;

-- Approved pilot pricing row (approved=false → displayed only as proposal, never charged)
insert into pricing_versions (id, approved, first_hour_cents, additional_hour_cents, first_24h_cap_cents, additional_day_cents, non_return_max_cents, non_return_after_hours)
values ('pilot-2026-v1', false, 699, 200, 1299, null, 4500, 72)
on conflict (id) do nothing;
