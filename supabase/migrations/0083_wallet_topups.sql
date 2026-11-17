-- Customer wallet funding. Credits are granted only after a verified Stripe webhook.
create table if not exists wallet_topups (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  amount_cents int not null check (amount_cents between 500 and 20000),
  status text not null default 'pending' check (status in ('pending','paid','failed','refunded')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  entitlement_grant_id uuid references entitlement_grants(id) on delete set null,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists wallet_topups_profile_idx on wallet_topups (profile_id, created_at desc);
create unique index if not exists wallet_topup_grant_once_idx on entitlement_grants (source_type, source_id)
  where source_type = 'wallet_topup';
alter table wallet_topups enable row level security;
create policy wallet_topups_owner_read on wallet_topups for select using (profile_id = auth.uid());
create policy wallet_topups_staff_read on wallet_topups for select using (is_staff());
