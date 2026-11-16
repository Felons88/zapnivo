-- Migration 0074 — per-kiosk test mode for pre-launch validation.
--
--   kiosks.test_mode — when true, the rental-facing availability gates
--   (state='online', installed_at, published venue, ready-bank count) are
--   relaxed for THIS station only, so staff can exercise the customer app,
--   station lookup, and checkout flow before hardware is deployed.
--   Payment still runs through Stripe — test mode never bypasses charging.
--   Default false; live stations are unaffected.
--   Toggled from System Control → device → Customer app QR.

alter table kiosks add column if not exists test_mode boolean not null default false;
