-- Migration 0003 — refund totals on payments
-- Kept in sync by the (future) Stripe webhook so support can show captured vs refunded amounts.
-- Stripe's live API remains the source of truth when linked (see src/lib/payments/source.ts).

alter table payments add column if not exists amount_refunded_cents int not null default 0 check (amount_refunded_cents >= 0);
