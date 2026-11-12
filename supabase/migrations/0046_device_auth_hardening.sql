-- Migration 0046 — per-device kiosk auth hardening (device-auth v2).
--
-- 1. system_devices.device_secret_enc — AES-256-GCM ciphertext of the device
--    secret, key-wrapped by the env KEK (DEVICE_CREDENTIAL_KEK). Format:
--    'v1.<iv_hex>.<tag_hex>.<ct_hex>'. device_secret_hash is RETAINED but is now
--    only a non-reversible fingerprint/identifier — it is NO LONGER used as the
--    HMAC verification key for credentials that have device_secret_enc set
--    (legacy rows without enc still verify hash-as-key until devices rotate).
-- 2. system_device_messages gains message_id / protocol_version / payload_sha256
--    plus a partial unique index on (device_id, message_id) — the atomic
--    dedup/replay arbiter for the X-Device-Message-Id header (nonce dedup;
--    out-of-order timestamps within the ±5min window are now accepted).
--
-- The bare received_at retention index already exists (migration 0045,
-- system_device_messages_received_idx) — intentionally NOT duplicated here.

-- ─── 1. Encrypted credential column ──────────────────────────────────────────
alter table system_devices
  add column if not exists device_secret_enc text;

-- ─── 2. Message dedup + protocol telemetry columns ───────────────────────────
alter table system_device_messages
  add column if not exists message_id text,
  add column if not exists protocol_version int,
  add column if not exists payload_sha256 text;

-- Atomic dedup claim: at most one row per (device, message_id). Partial so
-- legacy/shared-secret attempts (message_id null) are unaffected. The unique
-- index — not application logic — is the race-safe arbiter.
create unique index if not exists system_device_messages_msgid_idx
  on system_device_messages (device_id, message_id)
  where message_id is not null;
