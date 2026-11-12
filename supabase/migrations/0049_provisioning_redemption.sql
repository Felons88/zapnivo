-- Migration 0049 — kiosk provisioning-token redemption support.
--
-- Phase 2.4 secure provisioning (pairs with src/lib/system/provisioning.ts and
-- POST /api/devices/provision):
--
-- Staff issue a single-use `znk_…` token via /api/system/kiosks/[id]/provision;
-- only its SHA-256 hash lands in system_devices.provision_token_hash (0042).
-- Redemption claims the token by atomically setting provision_token_used_at
-- with `WHERE provision_token_used_at IS NULL` — no schema change is required
-- for the claim itself; the columns already exist.
--
-- What this migration adds: a PARTIAL index on provision_token_hash so the
-- redemption lookup stays an index scan instead of a seq scan. The predicate
-- keeps the (overwhelmingly NULL) column out of the index for every device
-- that has no live token.
--
-- Recovery semantics (no schema needed, documented for ops):
--  * If credential issuance fails after a successful claim, the route clears
--    provision_token_used_at back to NULL (compensating write) so the same
--    token can be retried.
--  * If the 200 response is lost in transit, staff re-issue the token via the
--    existing issue endpoint — issueProvisionToken already resets
--    provision_token_used_at on re-issue.
--  * The raw token and the issued device secret are NEVER persisted; only
--    sha256(token) and the AES-256-GCM-wrapped secret (device_secret_enc)
--    exist at rest.

create index if not exists system_devices_provision_token_hash_idx
  on system_devices (provision_token_hash)
  where provision_token_hash is not null;
