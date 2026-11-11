-- Monetization fix — event passes must not be redeemable before payment clears.
alter table event_passes
  add column if not exists paid_at timestamptz,
  add column if not exists stripe_checkout_session_id text;
-- Passes start unpaid; webhook stamps paid_at. Redemption requires paid_at not null.
