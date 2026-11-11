-- Close residual races from the monetization regression audit.
-- 1) One active/trialing one-time membership per (profile, plan).
create unique index if not exists customer_memberships_one_active
  on customer_memberships (profile_id, plan_id)
  where status in ('active', 'trialing');

-- 2) Direct Stripe PI references so refund/dispute reconciliation doesn't
--    need a Stripe API fallback for these products.
alter table event_passes add column if not exists stripe_payment_intent_id text;
alter table customer_memberships add column if not exists stripe_payment_intent_id text;
create index if not exists event_passes_pi_idx on event_passes (stripe_payment_intent_id) where stripe_payment_intent_id is not null;
create index if not exists customer_memberships_pi_idx on customer_memberships (stripe_payment_intent_id) where stripe_payment_intent_id is not null;
