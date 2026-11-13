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
