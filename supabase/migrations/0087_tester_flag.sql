-- Migration 0087 — tester flag on profiles.
-- Test-mode kiosks are never listed publicly. Flagged testers and staff get
-- them in the mobile stations payload (clearly marked test_mode) so the
-- pre-launch app can exercise the full rental/return flow on lab hardware.
alter table public.profiles
  add column if not exists is_tester boolean not null default false;
