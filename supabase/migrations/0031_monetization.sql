-- Monetization stage 2 — migration 0031
-- Entitlement engine (grants + events + atomic redeem RPC), prepaid packages,
-- gift credits (extends 0027), rental groups, event charging programs.

-- ─── Entitlement grants ─────────────────────────────────────────────────────
-- One row per benefit bucket. `remaining` is decremented atomically by the
-- redeem_entitlement RPC; events table is the audit trail.
create table entitlement_grants (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  kind text not null,                            -- 'membership'|'gift'|'prepaid'|'event'|'promo'|'adjustment'
  unit text not null check (unit in ('rental','minute','cent')),
  granted int not null check (granted > 0),
  remaining int not null check (remaining >= 0),
  expires_at timestamptz,
  source_type text,                              -- 'membership'|'gift_credit'|'package_purchase'|'event_pass'|'manual'
  source_id text,
  status text not null default 'active' check (status in ('active','depleted','expired','revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (remaining <= granted)
);
create index entitlement_grants_profile_idx on entitlement_grants (profile_id, status, expires_at);

create table entitlement_events (
  id bigint generated always as identity primary key,
  grant_id uuid references entitlement_grants(id) on delete set null,
  profile_id uuid not null references profiles(id) on delete cascade,
  event text not null check (event in ('grant','redeem','expire','adjust','revoke','refund')),
  delta int not null,                            -- +grant, -redeem, etc.
  balance_after int,
  ref_type text,                                 -- 'rental'|'gift'|'membership'|'manual'
  ref_id text,
  actor text,                                    -- 'system'|'customer'|'staff:<uuid>'|'webhook'
  note text,
  created_at timestamptz not null default now()
);
create index entitlement_events_profile_idx on entitlement_events (profile_id, created_at desc);
create index entitlement_events_grant_idx on entitlement_events (grant_id, created_at);

-- Atomic redemption: locks the oldest eligible grant row, decrements, logs.
-- Returns grant id or raises. Prevents negative balances and double-spend
-- under concurrency (SELECT ... FOR UPDATE inside one transaction).
create or replace function redeem_entitlement(
  p_profile uuid, p_unit text, p_amount int,
  p_ref_type text default null, p_ref_id text default null, p_actor text default 'system'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  g record;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'invalid_amount'; end if;
  select * into g from entitlement_grants
    where profile_id = p_profile and unit = p_unit and status = 'active'
      and remaining >= p_amount
      and (expires_at is null or expires_at > now())
    order by expires_at asc nulls last, created_at asc
    limit 1
    for update skip locked;
  if not found then raise exception 'insufficient_entitlement'; end if;
  update entitlement_grants
    set remaining = remaining - p_amount,
        status = case when remaining - p_amount = 0 then 'depleted' else status end,
        updated_at = now()
    where id = g.id;
  insert into entitlement_events (grant_id, profile_id, event, delta, balance_after, ref_type, ref_id, actor)
    values (g.id, p_profile, 'redeem', -p_amount, g.remaining - p_amount, p_ref_type, p_ref_id, p_actor);
  return g.id;
end $$;

-- Grant helper: inserts grant + grant event atomically.
create or replace function grant_entitlement(
  p_profile uuid, p_kind text, p_unit text, p_amount int,
  p_expires_at timestamptz, p_source_type text, p_source_id text, p_actor text default 'system', p_note text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare gid uuid;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'invalid_amount'; end if;
  insert into entitlement_grants (profile_id, kind, unit, granted, remaining, expires_at, source_type, source_id)
    values (p_profile, p_kind, p_unit, p_amount, p_amount, p_expires_at, p_source_type, p_source_id)
    returning id into gid;
  insert into entitlement_events (grant_id, profile_id, event, delta, balance_after, ref_type, ref_id, actor, note)
    values (gid, p_profile, 'grant', p_amount, p_amount, p_source_type, p_source_id, p_actor, p_note);
  return gid;
end $$;

-- Sweep expired grants (called by cron). Marks expired + logs.
create or replace function expire_entitlements() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with expired as (
    update entitlement_grants set status = 'expired', updated_at = now()
    where status = 'active' and expires_at is not null and expires_at <= now() and remaining > 0
    returning id, profile_id, remaining
  )
  insert into entitlement_events (grant_id, profile_id, event, delta, balance_after, actor)
    select id, profile_id, 'expire', -remaining, 0, 'system' from expired;
  get diagnostics n = row_count;
  return n;
end $$;

-- ─── Prepaid packages ───────────────────────────────────────────────────────
create table prepaid_packages (
  id text primary key,
  name text not null,
  description text,
  kind text not null check (kind in ('rental','minute','cent')),
  units int not null check (units > 0),
  price_cents int not null check (price_cents > 0),
  validity_days int,                               -- null = never expires
  active boolean not null default false,           -- staff activates; nothing sells until true
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table package_purchases (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  package_id text not null references prepaid_packages(id),
  status text not null default 'pending' check (status in ('pending','paid','redeemed','refunded','expired')),
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  amount_cents int not null,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  unique (stripe_checkout_session_id)
);
create index package_purchases_profile_idx on package_purchases (profile_id, created_at desc);

-- ─── Membership period tracking ─────────────────────────────────────────────
alter table customer_memberships
  add column if not exists last_granted_period_end timestamptz,
  add column if not exists cancel_at_period_end boolean not null default false;

-- ─── Rental groups ──────────────────────────────────────────────────────────
create table rental_groups (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  max_members int not null default 10 check (max_members between 1 and 50),
  credit_cents int not null default 0 check (credit_cents >= 0),  -- shared prepaid pool
  status text not null default 'active' check (status in ('active','closed')),
  created_at timestamptz not null default now()
);
create table rental_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references rental_groups(id) on delete cascade,
  profile_id uuid references profiles(id) on delete cascade,       -- null until claimed
  invite_email citext,
  invite_token_hash text,                                          -- sha256; raw token shown once
  status text not null default 'invited' check (status in ('invited','active','removed')),
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  unique (group_id, profile_id),
  unique (group_id, invite_email)
);
create index rental_group_members_group_idx on rental_group_members (group_id, status);

-- ─── Event charging programs ────────────────────────────────────────────────
create table event_programs (
  id uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  venue_id uuid references venues(id) on delete set null,          -- single-venue scope for now
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'draft' check (status in ('draft','active','paused','closed','cancelled')),
  package_id text references prepaid_packages(id),                  -- optional attached package
  max_redemptions int,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create table event_passes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references event_programs(id) on delete cascade,
  holder_id uuid references profiles(id) on delete set null,
  code_hash text not null unique,                                   -- sha256 of pass code
  units_granted int not null check (units_granted > 0),
  units_used int not null default 0 check (units_used >= 0),
  expires_at timestamptz,
  status text not null default 'active' check (status in ('active','redeemed','expired','revoked')),
  created_at timestamptz not null default now()
);
create index event_passes_event_idx on event_passes (event_id, status);

-- ─── Gift credits: extend 0027 with redemption attempt tracking ─────────────
alter table gift_credits
  add column if not exists attempts int not null default 0,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists refunded_at timestamptz,
  add column if not exists refunded_by uuid references profiles(id) on delete set null;

-- ─── RLS ─────────────────────────────────────────────────────────────────────
alter table entitlement_grants enable row level security;
alter table entitlement_events enable row level security;
alter table prepaid_packages enable row level security;
alter table package_purchases enable row level security;
alter table rental_groups enable row level security;
alter table rental_group_members enable row level security;
alter table event_programs enable row level security;
alter table event_passes enable row level security;

create policy staff_grants on entitlement_grants for all using (is_staff());
create policy staff_gentevents on entitlement_events for all using (is_staff());
create policy staff_packages on prepaid_packages for all using (is_staff());
create policy staff_purchases on package_purchases for all using (is_staff());
create policy staff_groups on rental_groups for all using (is_staff());
create policy staff_groupmembers on rental_group_members for all using (is_staff());
create policy staff_events on event_programs for all using (is_staff());
create policy staff_eventpasses on event_passes for all using (is_staff());

-- Customers read their own grants/events/purchases/groups (writes via service role).
create policy own_grants on entitlement_grants for select using (profile_id = auth.uid());
create policy own_gentevents on entitlement_events for select using (profile_id = auth.uid());
create policy own_purchases on package_purchases for select using (profile_id = auth.uid());
create policy own_groups on rental_groups for select using (organizer_id = auth.uid());
create policy own_groupmembers on rental_group_members for select using (
  profile_id = auth.uid() or exists (select 1 from rental_groups g where g.id = rental_group_members.group_id and g.organizer_id = auth.uid())
);
create policy own_events on event_programs for select using (organizer_id = auth.uid());
create policy own_eventpasses on event_passes for select using (holder_id = auth.uid());
