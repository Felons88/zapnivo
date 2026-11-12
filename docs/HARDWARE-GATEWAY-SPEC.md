# Hardware Gateway Integration Spec — Zapnivo Kiosk Fleet

Status: **control-plane contract implemented; vendor wire protocol TBD.**

This document specifies how a kiosk gateway (hardware vendor TBD) integrates with
Zapnivo's ingest and command surfaces. Every claim below is grounded in shipped
code — file references are given per section. Anything that depends on the
manufacturer's protocol documentation is marked **[REQUIRES VENDOR DOCS]** and
nothing is fabricated.

Primary sources:

- `src/lib/system/device-auth.ts` — per-device HMAC credential lifecycle + request verification (protocol v2)
- `src/app/api/devices/events/route.ts` — event ingest endpoint
- `src/lib/kiosk/ingest.ts` — request body schema + ingest pipeline
- `src/lib/kiosk/lifecycle.ts` — event semantics (heartbeat / return / ignored)
- `src/lib/kiosk/adapter-contract.ts` — hardware-facing contract (types only)
- `src/lib/kiosk/commands.ts`, `src/lib/kiosk/adapter.ts` — command queue + adapter facade
- `src/lib/system/kiosks.ts`, `src/lib/system/hardware.ts` — fleet registry, diagnostics, readiness
- `supabase/migrations/0044`, `0046`, `0048` — schema for `system_devices`, `system_device_messages`, rotation columns

---

## 1. Device identity

Two identity layers exist and both are required:

| Layer | Table | Key fields | Notes |
|---|---|---|---|
| Fleet registry | `system_devices` | `id` (uuid), `device_uid` (e.g. `kiosk-<hex>`), `serial_number`, `manufacturer`, `model`, `gateway`, `adapter_type`, `capabilities` (jsonb), `slot_count`, `firmware_version`, `venue_id`, `region`, `status` | Ops-managed via `/system/kiosks`. `status` lifecycle: `pending → registered → provisioning → testing → active` (+ `maintenance`, `suspended`, `quarantined`, `decommissioned`). Only `active` and `testing` may authenticate. |
| Rental-facing station | `kiosks` | `id`, `station_id`, `state` (`online`/`offline`/`provisioning`/…), `last_seen_at` | What customers rent against. The ingest body's `station_id` must equal the `system_devices.device_uid` **or** `serial_number` of the authenticated device. |

- **`X-Device-Id`** accepts either the `device_uid` or the row `id` (uuid).
- **Gateway association** is the `gateway` column on `system_devices` — a free-text
  vendor/gateway identifier recorded at registration. There is no separate gateway
  registry table; a gateway serving multiple kiosks is represented by N
  `system_devices` rows sharing the `gateway` value. **[REQUIRES VENDOR DOCS]** for
  how the physical gateway multiplexes multiple kiosk endpoints.
- **Provisioning tokens** (`znk_…`, 72 h, single-use, SHA-256 hashed at rest) exist
  on `system_devices` (`issueProvisionToken`) but are **not yet consumed by ingest** —
  see the FOLLOW-UP note in `src/lib/system/kiosks.ts:272`. Device onboarding today
  is: register → issue credential → device authenticates with HMAC.
- **Hardware profiles** (`system_hardware_profiles`, migration 0044) record per
  manufacturer+model capability claims (`dispense_supported`, `return_detection`,
  `inventory_reporting`, `heartbeat_supported`, `firmware_update`, `ad_screen`,
  `protocol_doc_url`, `gateway_api_spec`, `auth_capabilities`,
  `certification_status ∈ uncertified|in_review|certified|deprecated`). The table is
  ops-managed only (no write API) and intentionally empty until a real unit is
  certified. `certification_status='certified'` is what flips the
  `hardware_confirmed` readiness stage to `verified`.

## 2. Gateway authentication (implemented — exact contract)

Every ingest request to `POST /api/devices/events` may authenticate two ways.
**HMAC is the required end-state**; the shared-secret path is a migration fallback.

### 2.1 Headers (protocol v2, HMAC path)

| Header | Required | Format |
|---|---|---|
| `X-Device-Id` | yes (HMAC path) | `device_uid` or device `id` uuid |
| `X-Device-Timestamp` | yes | Unix **seconds or milliseconds**; must be within **±5 minutes** of server time (`DEVICE_AUTH_WINDOW_MS`) |
| `X-Device-Signature` | yes | Lowercase hex HMAC-SHA256, 64 chars |
| `X-Device-Message-Id` | yes (HMAC path) | 8–128 chars of `[A-Za-z0-9_-]`; unique per device — the replay/dedup nonce |
| `X-Device-Protocol` | no | Integer 1–999, default `1`; recorded on the message row |

### 2.2 Signature computation (exact)

```
signingKey  = hex( sha256( secret ) )            # 64-char hex string, used as HMAC key
signedMsg   = `${X-Device-Timestamp}.${rawBody}` # timestamp header value VERBATIM + "." + exact request body bytes
X-Device-Signature = hex( HMAC-SHA256( key = signingKey, msg = signedMsg ) )
```

- `rawBody` is the **exact bytes sent** — the route reads `req.text()` once and the
  HMAC covers those bytes. Do not re-serialize JSON differently than what is sent.
- The timestamp in the signed message is the header **string as sent** (seconds or
  ms — pick one and keep it consistent).
- `signDeviceRequest(secret, timestamp, body)` in `device-auth.ts` is the reference
  implementation and the simulator/test helper.

### 2.3 Credential issuance & storage (server side)

- Issued by staff via `POST /api/system/kiosks/[id]/credential`
  (`system.kiosks.manage` + step-up elevation for mutations). Returns the raw secret
  **exactly once**; it is never retrievable again.
- Secret format: `znd_` + 32 bytes base64url. TTL: **365 days**
  (`DEVICE_CREDENTIAL_TTL_MS`); `credential_expires_at` enforced at verify.
- At rest: `device_secret_enc` = AES-256-GCM ciphertext `v2.<keyver>.<iv>.<tag>.<ct>`
  with the device uuid as GCM AAD (row-bound — a ciphertext copied to another device
  fails the tag check). Key-wrapped by env `DEVICE_CREDENTIAL_KEK` (64 hex chars).
  `device_secret_hash` = `sha256(secret)` is a **fingerprint only** — for v2 rows it
  is NOT the HMAC key (the secret is decrypted transiently at verify). Legacy
  pre-v2 rows (enc = null) still verify with hash-as-key and are flagged
  `key_mode='legacy_hash'` in telemetry.
- KEK rotation: `DEVICE_CREDENTIAL_KEK_PREVIOUS` is tried on decrypt failure;
  per-device re-encryption via `reencryptDeviceCredential` (verify-before-write,
  audited `kiosk.credential_reencrypted`). No automatic KEK rotation.
- Every auth attempt — ok or rejected — writes a `system_device_messages` row
  (`auth_method`, `result`, reason code). Secrets, signatures, enc payloads and
  hashes are **never** recorded.

### 2.4 Legacy fallback (migration only)

`Authorization: Bearer $KIOSK_INGEST_SECRET` is accepted **only** while
`KIOSK_LEGACY_INGEST=1` AND the target station is not bound to a `system_devices`
row with a live `hmac_sha256` credential (`auth_method='shared_secret_legacy'` in
telemetry). New gateways MUST use HMAC; do not build on the shared secret.

## 3. Message envelope — `POST /api/devices/events`

Request body (`ingestBodySchema`, zod — `src/lib/kiosk/ingest.ts`):

```jsonc
{
  "station_id": "string, 1–40 chars — REQUIRED; must equal the device's device_uid or serial_number",
  "firmware_version": "string ≤40 chars — OPTIONAL; updates kiosks.firmware_version when present",
  "events": [                                    // 1–200 per request
    {
      "event_id": "string ≤120 — OPTIONAL per-event replay key (see §7)",
      "type": "string 1–60 — REQUIRED; see §4 for semantics",
      "slot": "int 1–64 — OPTIONAL",
      "slot_state": "empty|charging|ready|fault — OPTIONAL",
      "power_bank_serial": "string ≤60 — OPTIONAL; upserts power_banks row",
      "battery_pct": "int 0–100 — OPTIONAL; stored on the power_banks row",
      "at": "ISO-8601 datetime — OPTIONAL device-reported event time",
      "payload": "object — OPTIONAL free-form vendor context (stored verbatim, never trusted for control)"
    }
  ]
}
```

Response `200`: `{ ok: true, accepted: <n>, outcomes: [...] }` — `outcomes` is one
entry per event: `heartbeat | ignored | out_of_order | already_returned |
returned | return_disputed | duplicate | rejected:<reason>`.

Error responses: `401` auth failure (missing headers, bad signature, revoked/expired
credential, bad timestamp, unknown device, legacy blocked) · `400` invalid
`X-Device-Protocol` · `403` device not bound to `station_id` or device status cannot
authenticate · `404` unknown station · `409` duplicate `message_id` ·
`422` invalid payload · `429` rate limited (60 auth attempts/min/device) ·
`503` backend/KEK/dedup-log unavailable.

All fields above are the **actual ingest schema** — there are no other top-level or
per-event fields. Vendor-specific telemetry (temperatures, motor currents, sensor
bitmaps, etc.) MUST ride inside `payload` or `events[].payload` — **[REQUIRES VENDOR
DOCS]** for which keys the gateway actually emits.

## 4. Message types

"Direction" is relative to the gateway. "Auth" is always the §2 HMAC contract unless
noted. "Idempotency key" is what makes a retry safe.

### 4.1 Heartbeat — gateway → server

- **Direction:** device-initiated POST, any cadence the vendor supports.
- **Auth:** full §2 HMAC.
- **Required fields:** `station_id`, `events[]` with at least one event of
  `type: "heartbeat"`. Optional: `firmware_version`, per-event `at`, `payload`.
- **Server effects:** `processKioskEvent` → outcome `heartbeat`; `kiosks.last_seen_at`
  updated; kiosk `state` `offline|provisioning → online` (a heartbeat from a
  `disabled`/`maintenance` kiosk does NOT re-enable it); `system_devices`
  `last_message_ts`/`last_authed_at`/`last_message_at` updated by auth verification.
- **Idempotency key:** request-level `X-Device-Message-Id` (dedup → 409 on replay).
  Per-event `event_id` dedup via `kiosk_events.event_id` unique index → `duplicate`
  outcome, skipped entirely.
- **Staleness:** kiosk-facing staleness is `HEARTBEAT_STALE_MIN = 15` min on
  `kiosks.last_seen_at` (`heartbeatStale`, `src/lib/kiosk/heartbeat.ts`; fleet sweep
  marks offline/alerts). NOTE: `system_devices.last_heartbeat_at` exists but is
  **not currently written by ingest** — control-plane freshness derives from
  `last_message_at`/`last_message_ts` (`deriveConnectivity` reads
  `last_heartbeat_at` only, so it reports `no_data` until a writer lands — honest
  gap, flagged for follow-up).

### 4.2 Inventory report — gateway → server

There is **no dedicated inventory message type**. Inventory state is reported
inline via slot events:

- **Direction:** device-initiated, same POST envelope.
- **Auth:** full §2 HMAC.
- **Required fields:** per event `type` (any non-reserved string, e.g. a vendor
  inventory snapshot type), `slot`, `slot_state` ∈ `empty|charging|ready|fault`.
  `power_bank_serial` + `battery_pct` identify/update the bank row.
- **Server effects:** `kiosk_slots` upsert on `(kiosk_id, slot_number)`;
  `power_banks` upsert on `serial` (sets `battery_pct`, `current_kiosk`);
  every non-duplicate event appended to immutable `device_events`.
- **Idempotency key:** per-event `event_id` (unique → replay is a `duplicate`
  no-op) plus request `X-Device-Message-Id`.
- **[REQUIRES VENDOR DOCS]:** whether the gateway pushes full-slot snapshots,
  deltas, or per-bank events; which `type` string(s) it uses; whether it reports
  bank identity by serial, RFID, or slot-only.

### 4.3 Dispense request — server → gateway

- **Direction:** server-initiated. Today the only implemented path is the durable
  queue: `queueCommand` (`src/lib/kiosk/commands.ts`) writes `device_commands`
  rows (`command ∈ disable|enable|reboot|unlock_slot`, unique `idempotency_key`,
  status `queued`). `KioskAdapter.dispense` (`adapter.ts`) is the intended control
  surface but `getKioskAdapter()` returns `NullKioskAdapter` →
  `{ status: "failed", reason: "unsupported" }`.
- **Auth:** n/a server-side; device-side delivery/auth is **[REQUIRES VENDOR DOCS]**
  (MQTT/HTTP-pull/vendor-cloud unknown).
- **Contract (types only, `adapter-contract.ts`):** `CommandEnvelope`
  `{ commandId (uuid = idempotency key), command, kioskId, issuedAt, expiresAt,
  nonce, payload }`; device MUST reject past `expiresAt`, MUST treat a repeated
  `commandId` as a no-op, and MUST return a `CommandAck`
  (`accepted|completed|failed|timeout|expired`). **No ack ingest endpoint exists
  yet** — see 4.4.
- **Idempotency key:** `commandId` / `device_commands.idempotency_key` (unique;
  `queueCommand` returns `{duplicate:true}` on conflict — safe no-op).

### 4.4 Dispense ack / return-of-command — gateway → server

- **Status: [BLOCKED: no ingest contract].** The event schema has no command-ack
  event type and `processKioskEvent` maps unknown types to `ignored`. A gateway
  MUST NOT encode acks as ordinary events expecting lifecycle effects; they would
  be logged to `device_events` and ignored. The honest interim behavior: unknown/
  unsupported event types are accepted (200) but produce outcome `ignored` —
  certification asserts exactly this (see test suite).
- **[REQUIRES VENDOR DOCS] + server follow-up:** ack transport (piggyback on
  ingest events vs. dedicated endpoint), `CommandAck` field mapping, and timeout
  policy (`timeout` is a first-class outcome — never report success without ack).

### 4.5 Return detection — gateway → server (IMPLEMENTED)

- **Direction:** device-initiated dock event.
- **Auth:** full §2 HMAC.
- **Recognized types:** `power_bank_docked`, `bank_returned`
  (`RETURN_EVENT_TYPES`, `lifecycle.ts`). Vendor aliases must map to one of these.
- **Required fields:** `type`; bank identity via `power_bank_serial` (top-level,
  resolves/creates `power_banks` row) or `payload.power_bank_id` /
  `payload.power_bank_serial` / `payload.rental_id`. Optional `slot`, `at`.
- **Server effects:** dedupe claim on `kiosk_events.event_id` (returns are ALWAYS
  claimed, even without `event_id` — null dedupes on the row itself); out-of-order
  detection vs. newer processed events of same type → `out_of_order`;
  bank↔rental verification (never completes on mismatch → `rejected:wrong_bank` /
  `unmatched_bank` / `no_open_rental`); post-deadline arrivals mark
  `return_disputed` for review; success → rental `state='returned'`,
  `returned_at` = device `at` when present else server UTC.
- **Idempotency key:** `event_id` (required in practice for safe replay).
- **[REQUIRES VENDOR DOCS]:** physical detection mechanism (optical/weight/RFID),
  dock-confirmation latency, and whether a docked-but-unrecognized bank is
  reported distinctly.

### 4.6 Error / fault reporting — gateway → server

- **Direction:** device-initiated.
- **Auth:** full §2 HMAC.
- **Contract:** no dedicated error schema. Report faults as events with a vendor
  `type` (e.g. `fault`, `sensor_error`) and details in `payload`; `slot_state:
  "fault"` marks a slot fault via `kiosk_slots`. Unknown types are logged to
  `device_events` with outcome `ignored` — they ARE durably recorded, just not
  lifecycle-processed.
- **Idempotency key:** `event_id` per event; `X-Device-Message-Id` per request.
- **[REQUIRES VENDOR DOCS]:** vendor error taxonomy to normalize into
  `KioskErrorCode` (`adapter-contract.ts`: `hardware_fault`, `no_inventory`,
  `offline`, `timeout`, `unsupported`, `unknown`, …).

## 5. Offline reconciliation

Contract exists as types (`OfflineReconciliationReport`,
`adapter-contract.ts`): buffered `pendingEvents` replayed oldest-first, deduped
server-side on `event_id`; `executedCommandIds`/`failedCommandIds` reconcile
`device_commands` rows stuck in `sent`.

**Implemented today:** event replay is safe — re-sent events with the same
`event_id` dedupe to `duplicate`; same `message_id` → HTTP 409 (the gateway should
treat 409 as "already delivered" and drop the buffer entry, NOT retry forever).
Command-ack reconciliation has **no ingest path** (§4.4) —
**[BLOCKED: no ingest contract]** for `executedCommandIds`/`failedCommandIds`.
**[REQUIRES VENDOR DOCS]:** buffer size, flush trigger (on-reconnect vs.
interval), and whether offline time ranges are reported.

## 6. Credential rotation (migration 0048 — implemented)

Zero-downtime rotation, three phases:

1. **Stage:** `startCredentialRotation` generates a new secret → stored in
   `device_secret_enc_next` (same v2 AAD-bound AES-256-GCM) with
   `credential_next_expires_at = now + 72h`. New secret returned once. Primary
   credential untouched. Refuses (409) if a rotation is already pending.
2. **Overlap (≤72 h):** BOTH secrets verify — `verifyDeviceAuth` resolves primary
   and next keys up front (no timing oracle). Primary auth does NOT promote.
3. **Promote-on-first-auth:** the first request signed with the next secret
   promotes it: `device_secret_enc ← enc_next`, `enc_next`/`next_expires_at`
   cleared, fresh `device_secret_hash`, `credential_issued_at`/`expires_at`
   reset (365 d), `credential_rotated_at` stamped, `last_message_ts` reset
   (fresh replay window). Audited `kiosk.credential_rotation_completed`.
   Guarded update (`eq device_secret_enc_next`) prevents double-promotion races.

Escape hatches: `cancelCredentialRotation` clears the next slot (primary
untouched); `revokeDeviceCredential` clears BOTH slots + stamps
`credential_revoked_at` + `auth_method='none'`. An **expired** next slot simply
stops verifying (`bad_signature` for the new secret) while the primary keeps
working — there is no automatic sweeper; stale `enc_next` rows are inert until
cancelled/revoked/re-staged (**[ops note: no expire sweep job exists]**).

KEK-level rotation is separate: `DEVICE_CREDENTIAL_KEK_PREVIOUS` +
`reencryptDeviceCredential` per device.

## 7. Command / message idempotency

Two independent dedup layers — both implemented:

| Layer | Key | Mechanism | Replay result |
|---|---|---|---|
| Request | `X-Device-Message-Id` | Partial unique index `system_device_messages(device_id, message_id)` — atomic claim inserted AFTER signature verification, BEFORE ingest | HTTP `409 duplicate_message` + rejected telemetry row |
| Event | `events[].event_id` | Unique `kiosk_events.event_id`; claim inserted before any side effects | outcome `duplicate`; event skipped entirely (no `device_events` row, no slot/rental effects) |
| Command (server→device) | `commandId` / `idempotency_key` | Unique `device_commands.idempotency_key`; `CommandEnvelope.commandId` contract | `{duplicate:true}` at queue; device MUST no-op repeats |

`message_id` rules: 8–128 chars `[A-Za-z0-9_-]`, unique **per device** (the same
id on two different devices is fine). Missing/malformed → `401`. Timestamps do
**not** have to increase — out-of-order delivery inside the ±5 min window is
accepted; `last_message_ts` only moves forward (`max()`).

## 8. Device time sync requirements

- `X-Device-Timestamp` must be within **±5 minutes** of server UTC
  (`DEVICE_AUTH_WINDOW_MS`). Outside → `401 bad_timestamp`. This is the ONLY
  hard clock requirement on the auth path.
- Accepts unix **seconds or milliseconds** (`parseDeviceTimestamp`: `>= 1e12`
  treated as ms).
- The signature covers the timestamp **string verbatim** — the device must sign
  exactly the characters it puts in the header.
- Event-level `at` is device-reported physical time used for return ordering and
  `returned_at`; server UTC is authoritative when absent. Out-of-order device
  events are handled (`out_of_order` outcome) — clock drift affects ordering
  accuracy, not acceptance.
- **Implication for gateways:** maintain NTP-disciplined RTC; a gateway that wakes
  from deep sleep with a stale clock must resync BEFORE signing or every request
  401s. There is no server-side "please resync" signal beyond the 401 —
  **[REQUIRES VENDOR DOCS]** for RTC/battery-backed time behavior.

## 9. Certification checklist → test suite

`tests/hardware-certification.test.ts` exercises the REAL functions
(`verifyDeviceAuth`, `issueDeviceCredential`, `startCredentialRotation`,
`cancelCredentialRotation`, `revokeDeviceCredential`, `reencryptDeviceCredential`,
`ingestKioskEvents`, `processKioskEvent` paths, `heartbeatStale`,
`deriveConnectivity`, `runDeviceDiagnostics`, `queueCommand`) against in-memory
Supabase stubs. Run: `npm test -- hardware-certification` (vitest).

| # | Certification item | Test name(s) |
|---|---|---|
| C1 | Provisioning: secret shown once; v2 enc stored; hash is fingerprint; secret never in patch/audit | `C1 · provisioning` |
| C2 | Valid HMAC accepted; signing-key derivation correct | `C2 · authentication` |
| C3 | Heartbeat records telemetry + kiosk liveness | `C3 · heartbeat` |
| C4 | Inventory reporting via slot_state events | `C4 · inventory reporting` |
| C5 | Read-only diagnostic (ping-equivalent) is honest — never fabricates | `C5 · read-only diagnostics` |
| C6 | Rotation overlap: both secrets verify; first next-auth promotes | `C6 · credential rotation` |
| C7 | Offline detection: stale heartbeat + auth timestamp window | `C7 · offline detection` |
| C8 | Reconnection: heartbeat restores online state | `C8 · reconnection` |
| C9 | Return detection end-to-end (dock → rental returned) | `C9 · return detection` |
| C10 | Dispense ack: `[BLOCKED: no ingest contract]` — unknown types honestly `ignored`; command queue idempotent | `C10 · dispense/command path` |
| C11 | Duplicate `message_id` → 409 | `C11 · idempotency` |
| C12 | Invalid signature → reject | `C12 · negative auth` |
| C13 | Revoked credential → reject | `C13 · negative auth` |
| C14 | Expired rotation window / expired primary → reject | `C14 · negative auth` |

A gateway PASSES certification when every applicable test is green AND the vendor
doc gaps in §4.3–4.6, §5 are resolved or explicitly waived. On pass, ops creates a
`system_hardware_profiles` row with `certification_status='certified'` and the
capability flags that were actually verified — which flips `hardware_confirmed`
readiness to `verified` for matching manufacturer+model.
