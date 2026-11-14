# Gateway Adapter Interface — Zapnivo Kiosk Fleet

Status: **interface defined; NO implementation registered. `KIOSK_ADAPTER=none` stays.**

This document specifies the server→gateway adapter seam: the TypeScript
contract a vendor hardware adapter must implement before Zapnivo may claim a
live hardware path. It complements `docs/HARDWARE-GATEWAY-SPEC.md`, which
specifies the device→server ingest wire protocol (HMAC auth, event envelope,
idempotency) that is already implemented.

Nothing in this document authorizes dispatching commands to hardware. A real
adapter may only be registered after the vendor documentation checklist (§4)
is satisfied AND the adapter passes certification (§5).

Primary sources:

- `src/lib/kiosk/gateway-adapter.ts` — **the interface** (`GatewayAdapter`),
  capability flags, `GatewayResult`/`GatewayError` taxonomy, `blockedAdapter`,
  `getGatewayAdapter()` resolution seam.
- `src/lib/kiosk/adapter-contract.ts` — hardware-facing types (`CommandEnvelope`,
  `CommandAck`, `KioskHeartbeat`, `OfflineReconciliationReport`,
  `KioskContractError`/`KioskErrorCode`).
- `src/lib/kiosk/adapter.ts` — narrower server facade (`KioskAdapter`,
  `NullKioskAdapter`, `IdempotentKioskAdapter`, `getKioskAdapter`).
- `src/lib/kiosk/commands.ts`, `src/lib/system/command-ops.ts`,
  `src/lib/system/device-config.ts` — durable command queue, ops dispatch,
  desired-state config (all fail closed today).
- `src/lib/system/device-auth.ts`, `src/app/api/devices/events/route.ts` —
  implemented inbound HMAC auth + ingest (see HARDWARE-GATEWAY-SPEC.md §2–3).

---

## 1. What the adapter is (and is not)

The **gateway adapter** is the server-side component that translates Zapnivo's
control-plane intent into vendor-protocol calls — and translates vendor
telemetry into the normalized shapes the ingest pipeline already accepts.

It is NOT:

- the ingest endpoint (already implemented: `POST /api/devices/events`,
  HMAC-SHA256 per HARDWARE-GATEWAY-SPEC.md §2);
- the command queue (`device_commands` / `system_device_commands` — durable,
  idempotent, adapter-agnostic);
- a simulator (`src/lib/kiosk/simulator.ts` is a test double, not hardware
  truth — `KIOSK_ADAPTER=simulator` resolves to the blocked adapter here).

Two adapter surfaces exist and must not be conflated:

| Surface | File | Role | Status |
|---|---|---|---|
| `KioskAdapter` | `src/lib/kiosk/adapter.ts` | Narrow server facade: `health()`, `dispense()` | `getKioskAdapter()` → `NullKioskAdapter` (always) |
| `GatewayAdapter` | `src/lib/kiosk/gateway-adapter.ts` | Full gateway contract: auth, ingest, dispatch, config, firmware, diagnostics | `getGatewayAdapter()` → `blockedAdapter` (always) |

`KIOSK_ADAPTER=none` (or unset) resolves both to fail-closed implementations.
A vendor name (e.g. `KIOSK_ADAPTER=acme-gw`) resolves to
`documentation_required` until a certified implementation is registered in
`REGISTERED_GATEWAY_ADAPTERS` (`gateway-adapter.ts`).

## 2. Interface contract (exact)

```ts
interface GatewayAdapter {
  readonly name: string;
  capabilities(): GatewayCapabilities;   // honest flags — false = cannot do

  authenticate(device): Promise<GatewayResult<DeviceCredentials>>;
  ingestHeartbeat(hb: KioskHeartbeat): Promise<GatewayResult<{ accepted: number }>>;
  ingestInventory(report: GatewayInventoryReport): Promise<GatewayResult<{ accepted: number }>>;

  dispatchCommand(envelope: CommandEnvelope): Promise<GatewayResult<CommandAck>>;
  commandStatus(commandId: string): Promise<GatewayResult<CommandAck | null>>;

  dispense(request: DispenseRequest): Promise<GatewayResult<DispenseResult>>;
  reportReturn(request: GatewayReturnRequest): Promise<GatewayResult<ReturnResult>>;

  updateConfig(update: GatewayConfigUpdate): Promise<GatewayResult<{ commandId: string }>>;
  updateFirmware(artifact: GatewayFirmwareArtifact): Promise<GatewayResult<{ commandId: string }>>;

  diagnostics(device): Promise<GatewayResult<GatewayDiagnostics>>;
  reconcile(report: OfflineReconciliationReport): Promise<GatewayResult<{ applied: number; duplicates: number }>>;
}
```

### 2.1 Rules every method MUST satisfy

1. **Fail closed.** Any error returns `{ ok:false, error }` — never a
   fabricated success, never a thrown vendor string crossing the boundary.
   Map vendor failures into `GatewayErrorCode`
   (`adapter_not_configured | documentation_required | unsupported_capability |
   adapter_error`) and, where device-side, `KioskErrorCode`
   (`unauthorized | device_unknown | offline | timeout | no_inventory |
   hardware_fault | unsupported | duplicate | expired | rejected | unknown`).
2. **Idempotency.** `CommandEnvelope.commandId` is the dedup key —
   `dispatchCommand`, `dispense`, `updateConfig`, `updateFirmware` MUST treat a
   repeated commandId as a no-op returning the recorded outcome.
3. **Honest acks.** `timeout` is a first-class outcome. A command that never
   acks is `timeout`, NEVER success.
4. **Expiry.** Commands past `expiresAt` MUST be rejected (`expired`).
5. **Capabilities are truthful.** `capabilities()` reports what the adapter
   can do TODAY. A capability that is not implemented reports `false` and its
   method returns `unsupported_capability`.
6. **Firmware is signed-only.** `updateFirmware` requires `sha256` +
   `signature` on `GatewayFirmwareArtifact` and MUST verify both before any
   flash. There is no unsigned-artifact path in the type system.
7. **No secrets in results.** Credentials, signatures, and tokens never appear
   in return values, logs, or audit detail beyond what `device-auth.ts`
   already records (fingerprints only).
8. **Config whitelist.** `updateConfig.desired` keys are limited to the
   `device-config.ts` whitelist (`heartbeat_interval_sec`, `maintenance_mode`,
   `ad_playlist_id`, `brightness`, `config_notes`). The adapter forwards;
   validation stays server-side.

### 2.2 Capability flags

`GatewayCapabilities` keys: `auth`, `heartbeatIngest`, `inventoryIngest`,
`commandDispatch`, `commandStatus`, `dispense`, `return`, `configUpdate`,
`firmwareUpdate`, `diagnostics`. The blocked adapter reports all `false`.

Update delivery uses a SEPARATE flag set — `GatewayUpdateCapabilities` keys:
`firmwareDelivery`, `configUpdatePush`, `updateStatusQuery`,
`installedVersionReport`, `reconnectVerification`, `rollbackSupport` — see §6.

## 3. Resolution & current dispatch behavior (verified)

`getGatewayAdapter()` (`gateway-adapter.ts`) reads `KIOSK_ADAPTER`:

| Env value | Result |
|---|---|
| unset / `none` | `blockedAdapter(adapter_not_configured)` |
| `simulator` | `blockedAdapter(adapter_not_configured)` — sim is a test double |
| registered vendor name | the registered factory's adapter |
| anything else | `blockedAdapter(documentation_required)` |

Existing dispatch surfaces already fail closed — verified, no changes needed:

- `recordDeviceCommand` (`src/lib/system/kiosks.ts`) → command row
  `state='failed'`, `result.reason='adapter_disabled'`.
- `dispatchConfig` (`src/lib/system/device-config.ts`) → command
  `state='failed'` (`adapter_disabled`/`adapter_unavailable`), revision `failed`.
- `queueCommand` (`src/lib/kiosk/commands.ts`) → `status='queued'` forever;
  `sweepStaleCommands` expires unclaimed commands to `unknown_outcome`. Nothing
  is ever marked sent without an adapter.
- `NullKioskAdapter.dispense` (`src/lib/kiosk/adapter.ts`) →
  `{ status:"failed", reason:"unsupported" }`.
- Ingest heartbeat from a `maintenance`/`disabled` kiosk does NOT re-enable it
  (`src/lib/kiosk/ingest.ts`).

## 4. Vendor documentation checklist — REQUIRED before registration

An adapter implementation may be registered in `REGISTERED_GATEWAY_ADAPTERS`
only when ALL of the following are documented by the vendor and verified
against the checklist:

- [ ] **Transport** — protocol (MQTT / HTTPS / vendor cloud / BLE), endpoints,
      ports, TLS requirements, and whether the gateway is device-initiated,
      server-initiated, or polled.
- [ ] **Auth scheme** — how the gateway/cloud authenticates Zapnivo (and how
      Zapnivo authenticates to it): scheme, key format, rotation, replay
      protection. Must map onto or extend the HMAC contract in
      HARDWARE-GATEWAY-SPEC.md §2 — the shared `KIOSK_INGEST_SECRET` fallback
      is migration-only and MUST NOT be built upon.
- [ ] **Heartbeat payload schema** — exact fields, cadence, clock source,
      firmware_version reporting. Must map to `KioskHeartbeat` /
      `ingestBodySchema` (`station_id`, `events[]`, `at`, `slot_state`,
      `power_bank_serial`, `battery_pct`, `payload`).
- [ ] **Inventory schema** — full-snapshot vs delta vs per-bank events; slot
      addressing; bank identity (serial / RFID / slot-only); charge-state
      semantics.
- [ ] **Command ack contract** — how `CommandEnvelope` reaches the device,
      ack transport (piggyback on ingest events vs dedicated channel),
      `CommandAck` field mapping, timeout behavior, and offline buffering.
      NOTE: today there is NO dedicated ack ingest endpoint — ack events ride
      the `/api/devices/events` envelope (`dispense_acknowledged`,
      `bank_released`, `dispense_failed`, `hardware_fault`, …); the vendor doc
      must confirm it can emit these types or a server-side extension is needed.
- [ ] **Dispense/return semantics** — idempotency guarantees on the device,
      `expiresAt` enforcement, slot selection policy, dock-detection mechanism
      and latency, unrecognized-bank reporting.
- [ ] **Config update flow** — whether `maintenance_mode` and the other
      whitelisted keys can be pushed, acked, and reported back
      (`reported` channel does not exist in ingest today —
      `reconcileReported` is implemented but unwired).
- [ ] **Firmware update flow** — artifact format, signing scheme, who signs
      (vendor vs Zapnivo), sha256/signature verification point, canary/
      staged-rollout support, rollback, brick-recovery. `GatewayFirmwareArtifact`
      models this; an unsigned path is non-conforming.
- [ ] **Rate limits & quotas** — vendor-imposed throttles, max message size,
      connection limits; must fit the ingest rate limit (60 auth
      attempts/min/device) and 200 events/request.
- [ ] **Offline behavior** — buffer size, flush triggers, clock discipline
      (NTP/RTC), behavior across reconnect (maps to
      `OfflineReconciliationReport`).
- [ ] **Error taxonomy** — vendor error codes → `KioskErrorCode` mapping table.
- [ ] **Certification requirements** — vendor SDK/firmware versions certified,
      test hardware available, RMA/field-failure escalation path.

## 5. Certification gate

Before `KIOSK_ADAPTER` may name a real adapter:

1. Vendor docs received and checklist (§4) completed with evidence links.
2. `system_hardware_profiles` row created for the manufacturer+model with
   `certification_status` progressed `uncertified → in_review → certified`
   (ops-managed, migration 0044 — no write API).
3. Adapter implemented against `GatewayAdapter`, unit-tested with the
   in-memory Supabase harness (pattern: `tests/system-device-config.test.ts`),
   and run against physical test hardware.
4. `tests/hardware-certification.test.ts` + new gateway-adapter tests green.
5. Only then: register in `REGISTERED_GATEWAY_ADAPTERS` and set
   `KIOSK_ADAPTER=<name>`.

Until then `KIOSK_ADAPTER=none` remains the honest configuration and every
dispatch path records explicit failures.

---

## 6. Remote update delivery (Phase 4.3)

Update delivery is an **optional extension** of `GatewayAdapter`, defined in
`src/lib/kiosk/gateway-adapter.ts` as the `GatewayUpdateCapable` interface.
A vendor adapter may satisfy the base contract (auth, ingest, commands,
dispense) without implementing it — `isGatewayUpdateCapable()` /
`updateCapabilitiesOf()` are the ONLY sanctioned way to detect support, and
`updateCapabilities()` must report honest per-surface flags. The blocked
adapter implements the interface with all-false capabilities and every method
returns `unsupported_capability`. Server-side orchestration lives in
`src/lib/system/update-config.ts`; UI in
`src/app/system/kiosks/updates/ConfigRolloutPanel.tsx`.

### 6.1 Per-surface contract

| Capability flag | Method | Contract |
|---|---|---|
| `firmwareDelivery` | `deliverFirmwareArtifact(GatewayFirmwareDeliveryRequest)` | Transfer a signed artifact (`GatewayFirmwareArtifact`: `artifactRef` + `sha256` + `signature` all required — no unsigned path). Idempotent on `commandId`. `resumeToken` is an opaque vendor cursor; adapters that cannot resume MUST reject non-empty tokens rather than silently restart. Returns `GatewayUpdateJobAccepted` — acceptance ≠ installation. |
| `configUpdatePush` | `pushConfigUpdate(GatewayConfigPushRequest)` | Push whitelisted desired-state (`device-config.ts` keys only; `schemaVersion` optional). Idempotent on `commandId`. Same accepted-not-completed rule. |
| `updateStatusQuery` | `queryUpdateStatus(GatewayUpdateJobRef)` | Poll the vendor-side job and map onto `GatewayUpdateJobState`. MUST distinguish `failed` from `unknown_outcome` (job lost / device vanished mid-transfer). |
| `installedVersionReport` | `reportInstalledVersion({deviceId, commandId?})` | Read back the version the device actually reports (telemetry or direct query). A version the device never reported is a failure — never infer from "transfer finished". |
| `reconnectVerification` | `verifyReconnect(GatewayUpdateJobRef)` | Post-update proof over the AUTHENTICATED device channel (HMAC ingest session re-established + health checks). A bare TCP/ping success is not verification. |
| `rollbackSupport` | `requestRollback(GatewayRollbackRequest)` | Restore a known-good artifact/config. `rollbackRef` is opaque; `sha256`+`signature` REQUIRED — rollback obeys the same signed-artifact rule as forward updates. |

### 6.2 State machine mapping

Vendor job states map onto `kiosk_update_targets.state` (migration 0067):

```
queued → transferring → installing → reconnecting → verifying → completed
branches: failed | unknown_outcome | investigating | recovery | cancelled
```

- `deliverFirmwareArtifact`/`pushConfigUpdate` success ⇒ target `queued`
  (or `transferring` once the vendor confirms bytes moving).
- `queryUpdateStatus.state` drives `transferring → installing → reconnecting
  → verifying` transitions verbatim.
- `verifyReconnect.verified === true` is a prerequisite for `verifying →
  completed`.
- A lost job or unreachable device mid-flight ⇒ `unknown_outcome`, never
  silently `completed` or `failed`.

### 6.3 Verification requirements — what 'completed' means

A target may ONLY be marked `completed` when ALL of the following hold:

1. `reportInstalledVersion` (or `queryUpdateStatus.evidence.installedVersion`)
   returns the target version from **authenticated device telemetry** — the
   same HMAC ingest channel as heartbeats, not a vendor-cloud assertion.
2. `evidence.healthOk === true` from the device's post-update health report.
3. `verifyReconnect.verified === true` for the same `commandId`.

For **config** rollouts the equivalent gate already exists server-side:
`device_config_revisions.status = 'applied'` requires `reconcileReported` to
match every whitelisted desired key against a device-reported snapshot.
`refreshConfigRolloutTargets` (`update-config.ts`) derives target states
exclusively from that revision state — `completed` is unreachable without
reported evidence. Until a reported-config ingest channel exists, config
targets honestly stall at `verifying`/`failed`.

### 6.4 Rollback semantics

- Rollback is a NEW forward operation (`requestRollback`), never a state
  rewrite: a new `kiosk_update_targets` row (or config revision) references
  the known-good artifact via `rollbackRef`.
- The rollback artifact MUST be signed and verified on-device exactly like a
  forward artifact; an unsigned or unverifiable rollback path is
  non-conforming.
- Config rollback reuses `proposeRollback` (device-config.ts): a new draft
  revision restoring the previously `applied` desired state.
- After rollback the same verification gate (§6.3) applies — the device must
  report the restored version + health before `completed`.

### 6.5 Vendor documentation additions (required before registration)

In addition to the §4 checklist, a update-capable adapter needs documented:

- [ ] **Artifact transport** — how bytes reach the device (direct push,
      presigned URL, vendor cloud relay, sneakernet import), chunking,
      integrity re-checks en route, and whether `artifactRef` is a URL, opaque
      package id, or storage path the adapter resolves.
- [ ] **Resume semantics** — whether interrupted transfers resume via
      `resumeToken`/offset, restart from scratch, or fail; max transfer size
      and time.
- [ ] **Signing verification on-device** — which signature scheme the
      firmware verifies (vendor key? Zapnivo key? dual-signed?), where
      verification happens (bootloader vs OS), and how a failed signature is
      reported (must surface as `failed`, never `unknown_outcome` ambiguity).
- [ ] **Rollback image** — whether the device retains a known-good image,
      golden-image restore, or A/B partition; how `rollbackRef` maps to it;
      whether rollback itself needs network.
- [ ] **Concurrency limits** — max simultaneous artifact transfers per
      gateway/device and per account; required for `concurrency_limit` on
      `kiosk_update_campaigns`.
- [ ] **Status reporting cadence** — how `queryUpdateStatus` state is
      produced (device-pushed events vs polled), expected latency per state,
      and how `installedVersion`/`healthOk` evidence is emitted.
- [ ] **Brick recovery** — recovery path when an update leaves the device
      unreachable (`recovery` target state), including whether the vendor
      offers a forced-reflash mechanism and its auth requirements.
