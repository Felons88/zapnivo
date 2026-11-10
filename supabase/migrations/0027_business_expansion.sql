-- Zapnivo business expansion — migration 0027
-- Advertising marketplace (orgs, campaigns, creatives, rate cards, ledger, delivery events),
-- sponsored charging, memberships, gift credits. Additive only; staff RLS + member-scoped reads.

-- ─── Advertiser organizations ────────────────────────────────────────────────
create table advertiser_orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_email citext not null,
  billing_email citext,
  website text,
  status text not null default 'pending' check (status in ('pending','active','suspended')),
  stripe_customer_id text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table advertiser_members (
  org_id uuid not null references advertiser_orgs(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  primary key (org_id, profile_id)
);

-- ─── Campaigns: extend the existing stub table ───────────────────────────────
alter table advertising_campaigns
  add column advertiser_org_id uuid references advertiser_orgs(id) on delete set null,
  add column objective text,
  add column budget_cents int check (budget_cents is null or budget_cents >= 0),
  add column spent_cents int not null default 0 check (spent_cents >= 0),
  add column pricing_model text not null default 'fixed' check (pricing_model in ('fixed','cpm','cpc','sponsored_credits')),
  add column targeting jsonb not null default '{}'::jsonb,   -- { station_ids, venue_ids, cities, venue_types }
  add column schedule jsonb not null default '{}'::jsonb,    -- { starts_at, ends_at, timezone, dayparts }
  add column payment_status text not null default 'unpaid' check (payment_status in ('unpaid','checkout_pending','paid','failed','refunded')),
  add column stripe_checkout_session_id text,
  add column stripe_payment_intent_id text,
  add column review_note text,
  add column submitted_at timestamptz,
  add column approved_by uuid references profiles(id) on delete set null,
  add column approved_at timestamptz,
  add column activated_at timestamptz;
create index ad_campaigns_org_idx on advertising_campaigns (advertiser_org_id);
create index ad_campaigns_status_idx on advertising_campaigns (status, payment_status);

-- ─── Creatives ───────────────────────────────────────────────────────────────
create table ad_creatives (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references advertising_campaigns(id) on delete cascade,
  kind text not null check (kind in ('image','video','text')),
  storage_path text,                            -- private 'ad-creatives' bucket path
  mime text, bytes int check (bytes is null or bytes >= 0),
  width int, height int, duration_ms int,
  headline text, body text, destination_url text,
  version int not null default 1,
  status text not null default 'draft' check (status in ('draft','submitted','approved','rejected','archived')),
  review_note text,
  reviewed_by uuid references profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ad_creatives_campaign_idx on ad_creatives (campaign_id, status);

-- ─── Pricing ─────────────────────────────────────────────────────────────────
create table ad_rate_cards (
  id uuid primary key default gen_random_uuid(),
  placement text not null,                      -- kiosk_screen, website, email, event
  pricing_model text not null check (pricing_model in ('fixed','cpm','cpc')),
  unit_price_cents int not null check (unit_price_cents >= 0),  -- per placement-day / per 1000 / per click
  min_spend_cents int not null default 0 check (min_spend_cents >= 0),
  duration_days int not null default 7 check (duration_days > 0),
  active boolean not null default true,
  note text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─── Financial ledger (advertising only; rentals keep their own tables) ─────
create table ad_ledger (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references advertising_campaigns(id) on delete cascade,
  kind text not null check (kind in ('charge','credit','refund')),
  amount_cents int not null,
  currency char(3) not null default 'usd',
  stripe_payment_intent_id text,
  stripe_refund_id text,
  status text not null default 'pending' check (status in ('pending','succeeded','failed','refunded')),
  note text,
  created_at timestamptz not null default now()
);
create index ad_ledger_campaign_idx on ad_ledger (campaign_id, kind);

-- ─── Verified delivery events ────────────────────────────────────────────────
create table ad_events (
  id bigint generated always as identity primary key,
  campaign_id uuid not null references advertising_campaigns(id) on delete cascade,
  creative_id uuid references ad_creatives(id) on delete set null,
  kiosk_id uuid references kiosks(id) on delete set null,
  kind text not null check (kind in ('manifest_delivered','playback','impression','click')),
  dedupe_key text unique,                        -- device-generated idempotency key
  occurred_at timestamptz not null default now()
);
create index ad_events_campaign_idx on ad_events (campaign_id, kind, occurred_at desc);

-- ─── Sponsored charging ──────────────────────────────────────────────────────
create table sponsor_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sponsor_name text not null,
  contact_email citext not null,
  status text not null default 'pending' check (status in ('pending','active','paused','completed','rejected')),
  credit_minutes int not null check (credit_minutes > 0),       -- minutes of rental time funded per redemption cap
  budget_cents int check (budget_cents is null or budget_cents >= 0),
  spent_cents int not null default 0 check (spent_cents >= 0),
  per_customer_minutes int not null default 30 check (per_customer_minutes > 0),
  per_day_minutes int check (per_day_minutes is null or per_day_minutes > 0),
  targeting jsonb not null default '{}'::jsonb,                 -- { station_ids, venue_ids, cities }
  starts_at timestamptz not null, ends_at timestamptz not null,
  review_note text,
  created_by uuid references profiles(id) on delete set null,
  approved_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table sponsored_redemptions (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references sponsor_campaigns(id) on delete cascade,
  rental_id uuid references rentals(id) on delete set null,
  customer_ref text,                              -- receipt email or profile id, never raw PII beyond existing norms
  minutes_covered int not null check (minutes_covered > 0),
  status text not null default 'applied' check (status in ('applied','voided','expired')),
  created_at timestamptz not null default now(),
  unique (rental_id)
);
create index sponsored_redemptions_campaign_idx on sponsored_redemptions (campaign_id, created_at desc);

-- ─── Memberships ─────────────────────────────────────────────────────────────
create table membership_plans (
  id text primary key,                            -- e.g. 'charge-10-2026'
  name text not null,
  description text,
  price_cents int not null check (price_cents >= 0),
  interval text not null check (interval in ('one_time','month','year')),
  benefit jsonb not null,                         -- { rental_minutes } or { rentals }
  active boolean not null default false,          -- staff activates; nothing sells until true
  stripe_price_id text,
  created_at timestamptz not null default now()
);

create table customer_memberships (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  plan_id text not null references membership_plans(id),
  status text not null default 'pending' check (status in ('pending','trialing','active','past_due','cancelled','expired')),
  stripe_subscription_id text unique,
  stripe_customer_id text,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customer_memberships_profile_idx on customer_memberships (profile_id, status);

-- ─── Gift credits ────────────────────────────────────────────────────────────
create table gift_credits (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,                 -- sha256 of the redemption code; raw code only ever shown once
  purchaser_email citext not null,
  purchaser_profile uuid references profiles(id) on delete set null,
  package text not null,                          -- display label, e.g. '1 free rental'
  value_cents int check (value_cents is null or value_cents >= 0),
  recipient_email citext,
  message text,
  status text not null default 'pending_payment' check (status in ('pending_payment','paid','redeemed','expired','refunded')),
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  expires_at timestamptz,
  redeemed_by uuid references profiles(id) on delete set null,
  redeemed_rental_id uuid references rentals(id) on delete set null,
  created_at timestamptz not null default now(),
  redeemed_at timestamptz
);
create index gift_credits_status_idx on gift_credits (status, created_at desc);

-- ─── RLS ─────────────────────────────────────────────────────────────────────
alter table advertiser_orgs enable row level security;
alter table advertiser_members enable row level security;
alter table ad_creatives enable row level security;
alter table ad_rate_cards enable row level security;
alter table ad_ledger enable row level security;
alter table ad_events enable row level security;
alter table sponsor_campaigns enable row level security;
alter table sponsored_redemptions enable row level security;
alter table membership_plans enable row level security;
alter table customer_memberships enable row level security;
alter table gift_credits enable row level security;

-- Staff full access (service role bypasses RLS; these govern staff JWTs).
create policy staff_orgs on advertiser_orgs for all using (is_staff());
create policy staff_members on advertiser_members for all using (is_staff());
create policy staff_adcreatives on ad_creatives for all using (is_staff());
create policy staff_rategards on ad_rate_cards for select using (is_staff());
create policy staff_adledger on ad_ledger for all using (is_staff());
create policy staff_adevents on ad_events for all using (is_staff());
create policy staff_sponsors on sponsor_campaigns for all using (is_staff());
create policy staff_sponsored on sponsored_redemptions for all using (is_staff());
create policy staff_memberships on customer_memberships for all using (is_staff());
create policy staff_gifts on gift_credits for all using (is_staff());

-- Advertiser members can read their own org graph (writes go through service-role API routes).
create policy member_orgs on advertiser_orgs for select using (
  exists (select 1 from advertiser_members m where m.org_id = advertiser_orgs.id and m.profile_id = auth.uid())
);
create policy member_members on advertiser_members for select using (
  exists (select 1 from advertiser_members m where m.org_id = advertiser_members.org_id and m.profile_id = auth.uid())
);
create policy member_campaigns on advertising_campaigns for select using (
  advertiser_org_id is not null and exists (select 1 from advertiser_members m where m.org_id = advertising_campaigns.advertiser_org_id and m.profile_id = auth.uid())
);
create policy member_adcreatives on ad_creatives for select using (
  exists (select 1 from advertising_campaigns c join advertiser_members m on m.org_id = c.advertiser_org_id where c.id = ad_creatives.campaign_id and m.profile_id = auth.uid())
);
create policy member_adledger on ad_ledger for select using (
  exists (select 1 from advertising_campaigns c join advertiser_members m on m.org_id = c.advertiser_org_id where c.id = ad_ledger.campaign_id and m.profile_id = auth.uid())
);

-- Customers read their own memberships and gift credits (purchased or received).
create policy own_memberships on customer_memberships for select using (profile_id = auth.uid());
create policy own_gifts on gift_credits for select using (purchaser_profile = auth.uid() or redeemed_by = auth.uid());

-- Rate cards and membership plans are public catalog reads (no sensitive data).
create policy public_rategards on ad_rate_cards for select using (active);
create policy public_plans on membership_plans for select using (active);
