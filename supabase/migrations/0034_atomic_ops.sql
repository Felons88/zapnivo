-- Monetization phase 3 — migration 0034
-- Atomic event-pass redemption, entitlement reserve/commit/release,
-- gift secure claim tokens, group self-serve funding, payment credit tracking.

-- ─── Entitlement reservations ───────────────────────────────────────────────
-- `reserved` on grants tracks held-but-uncommitted units; `remaining` is
-- committed-and-available. available = remaining - reserved... define clearly:
--   granted - consumed = remaining (decremented on commit)
--   reserved  = held for in-flight rentals (incremented on reserve)
--   spendable = remaining - reserved
alter table entitlement_grants
  add column if not exists reserved int not null default 0 check (reserved >= 0);
alter table entitlement_grants drop constraint if exists entitlement_grants_check1;
alter table entitlement_grants add constraint entitlement_grants_remaining_reserved check (remaining + reserved <= granted);

create table entitlement_reservations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  grant_id uuid not null references entitlement_grants(id) on delete cascade,
  rental_id uuid references rentals(id) on delete set null,
  unit text not null check (unit in ('rental','minute','cent')),
  amount int not null check (amount > 0),
  status text not null default 'reserved' check (status in ('reserved','committed','released')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index entitlement_reservations_rental_idx on entitlement_reservations (rental_id, status);
create index entitlement_reservations_profile_idx on entitlement_reservations (profile_id, status);
-- One open reservation per (rental, grant) — idempotent reserve retries collapse.
create unique index entitlement_reservations_open_idx on entitlement_reservations (rental_id, grant_id) where status = 'reserved' and rental_id is not null;

alter table entitlement_reservations enable row level security;
create policy staff_reservations on entitlement_reservations for all using (is_staff());
create policy own_reservations on entitlement_reservations for select using (profile_id = auth.uid());

-- Reserve: pick oldest eligible grant with enough SPENDABLE balance, hold amount.
create or replace function reserve_entitlement(
  p_profile uuid, p_unit text, p_amount int, p_rental_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare g record; rid uuid;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'invalid_amount'; end if;
  -- Idempotent: an open reservation for this rental+unit+amount already exists → return it.
  if p_rental_id is not null then
    select id into rid from entitlement_reservations
      where rental_id = p_rental_id and profile_id = p_profile and unit = p_unit
        and amount = p_amount and status = 'reserved' limit 1;
    if rid is not null then return rid; end if;
  end if;
  select * into g from entitlement_grants
    where profile_id = p_profile and unit = p_unit and status = 'active'
      and (remaining - reserved) >= p_amount
      and (expires_at is null or expires_at > now())
    order by expires_at asc nulls last, created_at asc
    limit 1 for update skip locked;
  if not found then raise exception 'insufficient_entitlement'; end if;
  update entitlement_grants set reserved = reserved + p_amount, updated_at = now() where id = g.id;
  insert into entitlement_reservations (profile_id, grant_id, rental_id, unit, amount)
    values (p_profile, g.id, p_rental_id, p_unit, p_amount) returning id into rid;
  return rid;
end $$;

-- Commit: consume a reservation (reserved → consumed). Idempotent on terminal states.
create or replace function commit_entitlement(p_reservation_id uuid, p_actor text default 'system')
returns boolean language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from entitlement_reservations where id = p_reservation_id for update;
  if not found then raise exception 'reservation_not_found'; end if;
  if r.status <> 'reserved' then return true; end if; -- already committed/released → no-op
  update entitlement_grants
    set reserved = reserved - r.amount, remaining = remaining - r.amount,
        status = case when remaining - r.amount = 0 and reserved - r.amount = 0 then 'depleted' else status end,
        updated_at = now()
    where id = r.grant_id;
  update entitlement_reservations set status = 'committed', resolved_at = now() where id = r.id;
  insert into entitlement_events (grant_id, profile_id, event, delta, balance_after, ref_type, ref_id, actor)
    values (r.grant_id, r.profile_id, 'redeem', -r.amount, null, 'rental', r.rental_id::text, p_actor);
  return true;
end $$;

-- Release: return a reservation to spendable balance. Idempotent.
create or replace function release_entitlement(p_reservation_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from entitlement_reservations where id = p_reservation_id for update;
  if not found then raise exception 'reservation_not_found'; end if;
  if r.status <> 'reserved' then return true; end if;
  update entitlement_grants set reserved = reserved - r.amount, updated_at = now() where id = r.grant_id;
  update entitlement_reservations set status = 'released', resolved_at = now() where id = r.id;
  return true;
end $$;

-- Release every open reservation tied to a rental (cancel/expiry path).
create or replace function release_rental_reservations(p_rental_id uuid)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with rel as (
    update entitlement_reservations set status = 'released', resolved_at = now()
    where rental_id = p_rental_id and status = 'reserved' returning grant_id, amount
  ), g as (
    update entitlement_grants gr set reserved = gr.reserved - rel.amount, updated_at = now()
    from rel where gr.id = rel.grant_id returning gr.id
  ) select count(*) into n from rel;
  return n;
end $$;

-- ─── Atomic event-pass redemption ───────────────────────────────────────────
-- Single transaction: validate pass + event + window + payment + limits,
-- claim pass, grant rental units, write audit. Raises coded exceptions.
create or replace function redeem_event_pass(p_code_hash text, p_profile uuid)
returns int language plpgsql security definer set search_path = public as $$
declare p record; e record; gid uuid;
begin
  select * into p from event_passes where code_hash = p_code_hash for update;
  if not found then raise exception 'invalid_code'; end if;
  if p.paid_at is null then raise exception 'unpaid'; end if;
  if p.status = 'revoked' then raise exception 'revoked'; end if;
  if p.status = 'redeemed' then raise exception 'already_redeemed'; end if;
  if p.status = 'expired' or (p.expires_at is not null and p.expires_at <= now()) then
    update event_passes set status = 'expired' where id = p.id and status = 'active';
    raise exception 'expired';
  end if;
  if p.status <> 'active' then raise exception 'unavailable'; end if;
  if p.units_used >= p.units_granted then raise exception 'exhausted'; end if;

  select * into e from event_programs where id = p.event_id for update;
  if not found then raise exception 'event_missing'; end if;
  if e.status <> 'active' then raise exception 'event_inactive'; end if;
  if now() < e.starts_at or now() > e.ends_at then raise exception 'outside_window'; end if;

  update event_passes
    set status = 'redeemed', units_used = units_granted, holder_id = p_profile
    where id = p.id and status = 'active';
  if not found then raise exception 'already_redeemed'; end if;

  -- Grant rental units (inline so it's in the same transaction).
  insert into entitlement_grants (profile_id, kind, unit, granted, remaining, expires_at, source_type, source_id)
    values (p_profile, 'event', 'rental', p.units_granted, p.units_granted, e.ends_at, 'event_pass', p.id::text)
    returning id into gid;
  insert into entitlement_events (grant_id, profile_id, event, delta, balance_after, ref_type, ref_id, actor, note)
    values (gid, p_profile, 'grant', p.units_granted, p.units_granted, 'event_pass', p.id::text, 'customer',
            'Event pass ' || left(p.id::text, 8) || ' — ' || e.name);
  return p.units_granted;
end $$;

-- ─── Gift secure claim (recipient-bound, one-time) ─────────────────────────
alter table gift_credits
  add column if not exists claim_token_hash text,
  add column if not exists claim_token_expires_at timestamptz;
create unique index if not exists gift_claim_token_idx on gift_credits (claim_token_hash) where claim_token_hash is not null;

-- Claim+redeem in one transaction: validates hash/expiry/status, marks redeemed,
-- grants cent credits. Returns jsonb {ok, error?, cents?, expires_at?}.
create or replace function claim_gift(p_token_hash text, p_profile uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare g record; gid uuid;
begin
  select * into g from gift_credits where claim_token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'invalid_token'); end if;
  if g.status <> 'paid' then return jsonb_build_object('ok', false, 'error', 'unavailable'); end if;
  if g.claim_token_expires_at is not null and g.claim_token_expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  if g.expires_at is not null and g.expires_at <= now() then
    update gift_credits set status = 'expired' where id = g.id;
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  if g.value_cents is null or g.value_cents <= 0 then return jsonb_build_object('ok', false, 'error', 'no_value'); end if;

  update gift_credits
    set status = 'redeemed', redeemed_by = p_profile, redeemed_at = now(),
        claim_token_hash = null, claim_token_expires_at = null
    where id = g.id and status = 'paid';
  if not found then return jsonb_build_object('ok', false, 'error', 'unavailable'); end if;

  insert into entitlement_grants (profile_id, kind, unit, granted, remaining, expires_at, source_type, source_id)
    values (p_profile, 'gift', 'cent', g.value_cents, g.value_cents, g.expires_at, 'gift_credit', g.id::text)
    returning id into gid;
  insert into entitlement_events (grant_id, profile_id, event, delta, balance_after, ref_type, ref_id, actor)
    values (gid, p_profile, 'grant', g.value_cents, g.value_cents, 'gift_credit', g.id::text, 'customer');
  return jsonb_build_object('ok', true, 'cents', g.value_cents, 'expires_at', g.expires_at);
end $$;

-- ─── Group self-serve funding ───────────────────────────────────────────────
create table group_credit_purchases (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references rental_groups(id) on delete cascade,
  organizer_id uuid not null references profiles(id) on delete cascade,
  amount_cents int not null check (amount_cents > 0),
  status text not null default 'pending' check (status in ('pending','paid','refunded')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index group_credit_purchases_group_idx on group_credit_purchases (group_id, created_at desc);
alter table group_credit_purchases enable row level security;
create policy staff_groupfunding on group_credit_purchases for all using (is_staff());
create policy own_groupfunding on group_credit_purchases for select using (organizer_id = auth.uid());

-- Atomic pool top-up used by the webhook (and admin adjustments keep their own path).
create or replace function fund_group_credit(p_purchase_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare p record;
begin
  select * into p from group_credit_purchases where id = p_purchase_id for update;
  if not found or p.status <> 'pending' then return false; end if;
  update group_credit_purchases set status = 'paid', paid_at = now() where id = p.id;
  update rental_groups set credit_cents = credit_cents + p.amount_cents where id = p.group_id;
  insert into entitlement_events (grant_id, profile_id, event, delta, balance_after, ref_type, ref_id, actor, note)
    select null, p.organizer_id, 'grant', p.amount_cents, g.credit_cents, 'group_credit', p.group_id::text, 'webhook', 'Group funding purchase'
    from rental_groups g where g.id = p.group_id;
  return true;
end $$;

-- ─── Payment credit tracking ────────────────────────────────────────────────
alter table payments add column if not exists credit_cents int not null default 0;
