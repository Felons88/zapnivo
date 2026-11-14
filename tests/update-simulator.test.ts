import { describe, expect, it } from "vitest";
import {
  SIM_SCENARIOS, SIMULATED, simulateUpdateScenario, simulateAllScenarios,
  persistSimulatedRun,
} from "@/lib/kiosk/update-simulator";

/**
 * Update simulator tests — the simulator is PURE (no DB, no hardware). Every
 * result must be marked simulated:true and must never claim a real outcome.
 */

describe("update-simulator", () => {
  it("every scenario is marked simulated and documents itself as such", () => {
    for (const name of SIM_SCENARIOS) {
      const r = simulateUpdateScenario(name);
      expect(r.simulated).toBe(true);
      expect(SIMULATED).toBe(true);
      expect(r.scenario).toBe(name);
      expect(r.states.length).toBeGreaterThan(0);
      expect(r.notes.join(" ")).toMatch(/SIMULATION ONLY|Simulated/i);
      expect(r.finalState).toBe(r.states[r.states.length - 1].state);
    }
  });

  it("success walks the full happy path to completed", () => {
    const r = simulateUpdateScenario("success", { fromVersion: "1.0.0", toVersion: "2.0.0" });
    expect(r.finalState).toBe("completed");
    const states = r.states.map((s) => s.state);
    expect(states).toEqual(["queued", "transferring", "installing", "reconnecting", "verifying", "completed"]);
  });

  it("failure-ish scenarios never end in completed", () => {
    for (const name of ["lost_connection", "failed_download", "version_mismatch", "unsupported_firmware", "interrupted", "unsupported_rollback"] as const) {
      const r = simulateUpdateScenario(name);
      expect(r.finalState).not.toBe("completed");
    }
  });

  it("lost_connection ends in unknown_outcome (the auto-block trigger)", () => {
    expect(simulateUpdateScenario("lost_connection").finalState).toBe("unknown_outcome");
  });

  it("interrupted ends in recovery — rollback is a new campaign, never automatic", () => {
    const r = simulateUpdateScenario("interrupted");
    expect(r.finalState).toBe("recovery");
    expect(r.notes.join(" ")).toMatch(/separate approved campaign|nothing auto-retries/i);
  });

  it("duplicate_update is idempotent — ends completed without re-flashing", () => {
    const r = simulateUpdateScenario("duplicate_update");
    expect(r.finalState).toBe("completed");
    expect(r.states).toHaveLength(2); // queued → completed, no transfer/install
  });

  it("simulateAllScenarios covers every declared scenario", () => {
    const all = simulateAllScenarios();
    expect(all).toHaveLength(SIM_SCENARIOS.length);
    expect(all.every((r) => r.simulated)).toBe(true);
  });

  it("persistSimulatedRun stamps simulated evidence and never writes 'completed'", async () => {
    const rows: Record<string, unknown>[] = [];
    const fakeDb = {
      from: () => ({
        update: (patch: Record<string, unknown>) => ({
          eq: async (_c: string, _v: string) => {
            rows.push(patch);
            return { error: null };
          },
        }),
      }),
    };
    const r = await persistSimulatedRun(fakeDb, "target-1", "success");
    expect(r.ok).toBe(true);
    expect(rows).toHaveLength(1);
    const result = rows[0].result as Record<string, unknown>;
    expect(result.simulated).toBe(true);
    expect(result.scenario).toBe("success");
    // 'completed' is NEVER written by the simulator — it lands 'investigating'
    // so simulated runs can never satisfy the verification gate.
    expect(rows[0].state).toBe("investigating");
    expect(rows[0].state).not.toBe("completed");
  });
});
