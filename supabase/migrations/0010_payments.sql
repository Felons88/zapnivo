-- Migration 0010 — payments & billing
-- Checkout sessions, tax/discount tracking, promo codes, webhook dedupe, richer disputes.
-- amount_refunded_cents already exists (0003) and is intentionally not re-added.

alter table payments add column if not exists stripe_checkout_session_id text unique;
alter table payments add column if not exists tax_cents int not null default 0 check (tax_cents >= 0);
alter table payments add column if not exists discount_cents int not null default 0 check (discount_cents >= 0);
alter table payments add column if not exists failure_code text;

alter table rentals add column if not exists bank_count int not null default 1 check (bank_count between 1 and 3);
alter table rentals add column if not exists promo_code text;
alter table rentals add column if not exists customer_id uuid references profiles(id);
create index if not exists rentals_customer_idx on rentals (customer_id);

alter table disputes add column if not exists amount_cents int;
alter table disputes add column if not exists currency char(3);
alter table disputes add column if not exists reason text;
alter table disputes add column if not exists evidence_due_by timestamptz;

-- Webhook dedupe: the primary key makes a replayed Stripe event id fail to insert.
create table if not exists stripe_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);
alter table stripe_events enable row level security;
drop policy if exists staff_stripe_events on stripe_events;
create policy staff_stripe_events on stripe_events for select using (is_staff());

create table if not exists promo_codes (
  code citext primary key,
  percent_off numeric(5,2) check (percent_off > 0 and percent_off <= 100),
  amount_off_cents int check (amount_off_cents > 0),
  active boolean not null default true,
  starts_at timestamptz,
  expires_at timestamptz,
  max_redemptions int check (max_redemptions is null or max_redemptions > 0),
  redemptions int not null default 0 check (redemptions >= 0),
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  constraint promo_exactly_one_discount check ((percent_off is null) <> (amount_off_cents is null))
);
alter table promo_codes enable row level security;
drop policy if exists staff_promo_codes on promo_codes;
create policy staff_promo_codes on promo_codes for select using (is_staff());

-- Atomic redemption: ONE conditional UPDATE, so concurrent checkouts can never exceed max_redemptions.
create or replace function redeem_promo(p_code text) returns promo_codes
language sql security definer set search_path = public as $$
  update promo_codes set redemptions = redemptions + 1
  where code = p_code and active
    and (starts_at is null or starts_at <= now())
    and (expires_at is null or expires_at > now())
    and (max_redemptions is null or redemptions < max_redemptions)
  returning *;
$$;

create or replace function release_promo(p_code text) returns void
language sql security definer set search_path = public as $$
  update promo_codes set redemptions = redemptions - 1 where code = p_code and redemptions > 0;
$$;

revoke execute on function redeem_promo(text), release_promo(text) from public, anon, authenticated;
grant execute on function redeem_promo(text), release_promo(text) to service_role;
