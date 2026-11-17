-- Migration 0076 — test-kiosk simulated dispense scenario.
--
--   kiosks.test_scenario — when a kiosk has test_mode=true, dispense commands
--   queued for rentals at it carry a `payload.sim` stage plan executed through
--   the REAL ingest pipeline (src/lib/kiosk/dispatch.ts). This column selects
--   which scenario the plan simulates: success | offline | jam | timeout |
--   empty | delayed_ack | duplicate_ack | partial | lost_ack.
--   NULL = 'success'. Only meaningful when test_mode is on; production kiosks
--   ignore it entirely. Set from System Control → device → Customer app QR.

alter table kiosks add column if not exists test_scenario text;

comment on column kiosks.test_scenario is
  'Simulated dispense scenario for test_mode kiosks (success/offline/jam/timeout/empty/delayed_ack/duplicate_ack/partial/lost_ack). NULL = success. Ignored on production kiosks.';
