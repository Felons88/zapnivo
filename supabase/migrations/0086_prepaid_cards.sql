-- Migration 0086 — Zapnivo closed-loop prepaid card.
--
-- Each signed-in customer gets one active card: a Zapnivo-only number (never a
-- payment-network BIN), an expiry on the last day of the issue month five years
-- out, and a 3-digit security code that is DERIVED from the number with a server
-- secret (never stored). The balance itself stays in entitlement_grants; this
-- table is only the card identity shown in the app and added to Google Wallet.
-- An expired card is retired and replaced; the balance carries over untouched.

create table if not exists prepaid_cards (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  pan text not null unique check (pan ~ '^[0-9]{16}$'),
  exp_month int not null check (exp_month between 1 and 12),
  exp_year int not null check (exp_year between 2024 and 2100),
  status text not null default 'active' check (status in ('active','frozen','expired')),
  issued_at timestamptz not null default now(),
  retired_at timestamptz
);
create unique index if not exists prepaid_cards_one_active_idx on prepaid_cards (profile_id) where status in ('active','frozen');
create index if not exists prepaid_cards_profile_idx on prepaid_cards (profile_id, issued_at desc);

alter table prepaid_cards enable row level security;
create policy prepaid_cards_owner_read on prepaid_cards for select using (profile_id = auth.uid());
create policy prepaid_cards_staff_read on prepaid_cards for select using (is_staff());
