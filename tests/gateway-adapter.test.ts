import { afterEach, describe, expect, it } from "vitest";
import {
  getGatewayAdapter, blockedAdapter, ADAPTER_NOT_CONFIGURED,
  NO_GATEWAY_CAPABILITIES, documentationRequired,
  __registerGatewayAdapterForTests, __unregisterGatewayAdapterForTests,
  type GatewayAdapter,
} from "@/lib/kiosk/gateway-adapter";
import { getKioskAdapter } from "@/lib/kiosk/adapter";

/**
 * Gateway adapter seam — fail-closed behavior. KIOSK_ADAPTER=none must never
 * fabricate a hardware path; unregistered names must report
 * documentation_required; the blocked adapter must fail EVERY method with an
 * explicit error and report all-false capabilities.
 */

const ENV = "KIOSK_ADAPTER";
const saved = process.env[ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;
  __unregisterGatewayAdapterForTests("test-gw");
});

describe("getGatewayAdapter resolution", () => {
  it("unset KIOSK_ADAPTER resolves to adapter_not_configured", () => {
    delete process.env[ENV];
    const a = getGatewayAdapter();
    expect(a.name).toBe("blocked");
    expect(Object.values(a.capabilities()).every((c) => c === false)).toBe(true);
    expect(a.capabilities()).toEqual(NO_GATEWAY_CAPABILITIES);
  });

  it("KIOSK_ADAPTER=none resolves to adapter_not_configured", () => {
    process.env[ENV] = "none";
    expect(getGatewayAdapter().name).toBe("blocked");
  });

  it("KIOSK_ADAPTER=simulator is NOT a hardware gateway — still blocked", () => {
    process.env[ENV] = "simulator";
    const a = getGatewayAdapter();
    expect(a.name).toBe("blocked");
    expect(Object.values(a.capabilities()).every((c) => c === false)).toBe(true);
  });

  it("an unregistered vendor name resolves to documentation_required", async () => {
    process.env[ENV] = "acme-gw";
    const a = getGatewayAdapter();
    const r = await a.dispense({ rentalId: "r1", stationId: "S1", idempotencyKey: "k1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("documentation_required");
  });

  it("a registered factory resolves its adapter", () => {
    process.env[ENV] = "test-gw";
    const stub: GatewayAdapter = {
      name: "test-gw",
      capabilities: () => ({ ...NO_GATEWAY_CAPABILITIES, dispense: true }),
      authenticate: async () => ({ ok: false, error: { code: "adapter_error", detail: "stub" } }),
      ingestHeartbeat: async () => ({ ok: true, data: { accepted: 0 } }),
      ingestInventory: async () => ({ ok: true, data: { accepted: 0 } }),
      dispatchCommand: async () => ({ ok: false, error: { code: "adapter_error", detail: "stub" } }),
      commandStatus: async () => ({ ok: true, data: null }),
      dispense: async () => ({ ok: true, data: { status: "failed", reason: "no_inventory" } }),
      reportReturn: async () => ({ ok: true, data: { status: "rejected", reason: "empty_slot" } }),
      updateConfig: async () => ({ ok: false, error: { code: "unsupported_capability", capability: "configUpdate", detail: "stub" } }),
      updateFirmware: async () => ({ ok: false, error: { code: "unsupported_capability", capability: "firmwareUpdate", detail: "stub" } }),
      diagnostics: async () => ({ ok: true, data: { checkedAt: "", adapter: "test-gw", checks: [] } }),
      reconcile: async () => ({ ok: true, data: { applied: 0, duplicates: 0 } }),
    };
    __registerGatewayAdapterForTests("test-gw", () => stub);
    expect(getGatewayAdapter()).toBe(stub);
  });
});

describe("blockedAdapter fails every method honestly", () => {
  const a = blockedAdapter(ADAPTER_NOT_CONFIGURED);

  it("reports all-false capabilities", () => {
    expect(a.capabilities()).toEqual(NO_GATEWAY_CAPABILITIES);
  });

  it("every method returns ok:false with the configured error", async () => {
    const results = await Promise.all([
      a.authenticate({ kioskId: "k1" }),
      a.ingestHeartbeat({ kioskId: "k1", at: "2026-01-01T00:00:00Z", slots: [] }),
      a.ingestInventory({ kioskId: "k1", at: "2026-01-01T00:00:00Z", slots: [] }),
      a.dispatchCommand({ commandId: "c1", command: "reboot", kioskId: "k1", issuedAt: "", expiresAt: "", nonce: "n" }),
      a.commandStatus("c1"),
      a.dispense({ rentalId: "r", stationId: "s", idempotencyKey: "i" }),
      a.reportReturn({ commandId: "c", kioskId: "k", issuedAt: "", expiresAt: "", nonce: "n" }),
      a.updateConfig({ deviceId: "d", commandId: "c", desired: {} }),
      a.updateFirmware({ deviceId: "d", commandId: "c", version: "1", artifactRef: "x", sha256: "s", signature: "g" }),
      a.diagnostics({ kioskId: "k" }),
      a.reconcile({ kioskId: "k", pendingEvents: [], executedCommandIds: [], failedCommandIds: [] }),
    ]);
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("adapter_not_configured");
    }
  });
});

describe("documentationRequired error", () => {
  it("names the selected adapter and points at the spec", () => {
    const e = documentationRequired("acme");
    expect(e.code).toBe("documentation_required");
    expect(e.detail).toContain("acme");
    expect(e.detail).toContain("GATEWAY-ADAPTER.md");
  });
});

describe("existing fail-closed dispatch surfaces (regression)", () => {
  it("getKioskAdapter dispense fails unsupported — never claims hardware", async () => {
    const r = await getKioskAdapter().dispense({ rentalId: "r", stationId: "s", idempotencyKey: "k" });
    expect(r).toEqual({ status: "failed", reason: "unsupported" });
  });

  it("NullKioskAdapter health reports null — no fabricated telemetry", async () => {
    expect(await getKioskAdapter().health("S1")).toBeNull();
  });
});
