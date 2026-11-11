-- Monetization — event pass pricing.
-- Event passes are sold via Stripe Checkout; the price must be known server-side
-- before the session is created. Nullable: falls back to the attached
-- prepaid_packages.price_cents when set; organizers/admins set it explicitly.
alter table event_programs
  add column if not exists price_cents int check (price_cents is null or price_cents > 0);
