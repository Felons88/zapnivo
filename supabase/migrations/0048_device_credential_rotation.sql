-- Migration 0048 — zero-downtime device credential rotation + KEK versioning.
--
-- Phase 2.2 device-auth hardening (pairs with src/lib/system/device-auth.ts):
--
-- 1. device_secret_enc_next / credential_next_expires_at stage a NEW
--    credential alongside the live one. Both secrets verify during the
--    overlap window; the first successful auth with the next secret promotes
--    it to device_secret_enc (credential_rotated_at stamped). Old hardware
--    keeps working until it picks up the new secret — no instant breakage.
-- 2. credential_rotated_at already exists (0044) — re-declared IF NOT EXISTS
--    for completeness on fresh installs.
--
-- Ciphertext format moves to v2.<keyver>.<iv>.<tag>.<ct> with AES-GCM AAD =
-- device uuid (row-bound; swap-between-devices fails the tag check) and a
-- keyver label from DEVICE_CREDENTIAL_KEK_VERSION. Legacy v1 payloads remain
-- decryptable. KEK rotation is staged via DEVICE_CREDENTIAL_KEK_PREVIOUS +
-- per-device reencryptDeviceCredential — no automatic rotation.

alter table system_devices
  add column if not exists device_secret_enc_next text,
  add column if not exists credential_next_expires_at timestamptz,
  add column if not exists credential_rotated_at timestamptz;

comment on column system_devices.device_secret_enc_next is
  'Staged next ingest credential (AES-256-GCM v2, AAD=device.id) during a zero-downtime rotation window. Cleared on promotion, cancel, or revoke.';
comment on column system_devices.credential_next_expires_at is
  'Expiry of the staged next credential (72h window from startCredentialRotation).';
comment on column system_devices.credential_rotated_at is
  'Last time a staged credential was promoted to primary (or set at decommission).';
