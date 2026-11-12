-- Migration 0052 — command/ack integrity: device_commands state machine columns.
--
-- Written by src/lib/kiosk/commands.ts (queueCommand / transitionCommand /
-- sweepStaleCommands / requeueCommand) and read by src/lib/kiosk/lifecycle.ts
-- (handleDeviceAck gating). No data is rewritten; existing rows keep working.
--
-- State machine (status values; 'acknowledged' ≡ 'confirmed' terminal-success):
--   queued → sent → awaiting_ack → acknowledged | confirmed
--                    └→ failed | timeout | cancelled | expired
--   open + expires_at passed → unknown_outcome   (lost ack ≠ failed action)
--   any → requires_investigation                  (staff review workspace)
--
-- New rental_exceptions kinds emitted by the ack gate (kind is free-text, no
-- CHECK — see 0050): cross_device_ack | stale_ack | conflicting_ack |
-- unexpected_ack_type | unexpected_command_state | command_timeout.

-- 1) Widen the status CHECK. Legacy values queued/sent/acknowledged/failed/expired
--    stay valid; awaiting_ack/confirmed/timeout/cancelled/unknown_outcome/
--    requires_investigation are added.
alter table device_commands drop constraint if exists device_commands_status_check;
alter table device_commands
  add constraint device_commands_status_check
  check (status in (
    'queued', 'sent', 'awaiting_ack',
    'acknowledged', 'confirmed', 'failed',
    'timeout', 'cancelled', 'expired',
    'unknown_outcome', 'requires_investigation'
  ));

-- 2) Ack contract: which inbound event types may resolve this command
--    (null/empty = any). Enforced in lifecycle.gateCommandAck.
alter table device_commands
  add column if not exists expected_response_types text[];

-- 3) Ack deadline: commands unanswered past this instant are swept to
--    unknown_outcome by sweepStaleCommands. Null = legacy row (24h age fallback).
alter table device_commands
  add column if not exists expires_at timestamptz;

-- 4) Requeue/audit bookkeeping.
alter table device_commands
  add column if not exists attempt_count int not null default 0;
alter table device_commands
  add column if not exists last_transition_at timestamptz;
alter table device_commands
  add column if not exists resolved_outcome text;   -- 'acknowledged'|'failed'|'timeout'|…

-- Backfill bookkeeping timestamps; expires_at stays null (legacy age rule applies).
update device_commands set last_transition_at = created_at where last_transition_at is null;

-- 5) Sweep support: find open commands past their deadline quickly.
create index if not exists device_commands_open_expiry_idx
  on device_commands (expires_at)
  where status in ('queued', 'sent', 'awaiting_ack');
create index if not exists device_commands_status_idx
  on device_commands (status, created_at desc);
