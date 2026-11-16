import { describe, expect, it } from "vitest";
import {
  buildBlockers, buildGates, summarizeChecks, launchReadiness,
  type LaunchCheck,
} from "@/lib/system/launch";

const check = (o: Partial<LaunchCheck> = {}): LaunchCheck => ({
  id: "test.check",
  subsystem: "payments",
  gate: "commercial",
  lines: ["full_platform"],
  label: "Test check",
  description: "desc",
  state: "pending",
  severity: "high",
  evidence: "evidence",
  evidenceKind: "live_db",
  lastChecked: "2026-01-01T00:00:00Z",
  action: "do the thing",
  actionHref: "/system/x",
  owner: "owner",
  autoVerifiable: true,
  manualRequired: false,
  ...o,
});

describe("summarizeChecks", () => {
  it("counts each state into the right bucket exactly once", () => {
    const s = summarizeChecks([
      check({ id: "a", state: "verified" }),
      check({ id: "b", state: "operational" }),
      check({ id: "c", state: "configured" }),
      check({ id: "d", state: "pending", severity: "critical" }),
      check({ id: "e", state: "manual" }),
      check({ id: "f", state: "blocked", severity: "critical" }),
    ]);
    expect(s.productionVerified).toBe(1);
    expect(s.operational).toBe(1);
    expect(s.needsConfiguration).toBe(2); // configured + pending
    expect(s.manualPending).toBe(1);
    expect(s.criticalBlockers).toBe(2); // pending+critical and blocked+critical
    expect(s.total).toBe(6);
  });
});

describe("buildBlockers", () => {
  it("emits one blocker per unsatisfied check and none for satisfied states", () => {
    const blockers = buildBlockers([
      check({ id: "sat1", state: "verified" }),
      check({ id: "sat2", state: "operational" }),
      check({ id: "sat3", state: "configured" }),
      check({ id: "sat4", state: "implemented" }),
      check({ id: "sat5", state: "test_verified" }),
      check({ id: "open1", state: "pending" }),
      check({ id: "open2", state: "blocked" }),
      check({ id: "open3", state: "manual" }),
    ]);
    expect(blockers.map((b) => b.id).sort()).toEqual(["open1", "open2", "open3"]);
    expect(blockers[0].checkId).toBe(blockers[0].id); // stable dedupe key
  });

  it("sorts critical before high before medium before low", () => {
    const blockers = buildBlockers([
      check({ id: "low", state: "pending", severity: "low" }),
      check({ id: "crit", state: "pending", severity: "critical" }),
      check({ id: "high", state: "pending", severity: "high" }),
    ]);
    expect(blockers.map((b) => b.id)).toEqual(["crit", "high", "low"]);
  });
});

describe("buildGates", () => {
  it("reports satisfied counts and worst unsatisfied state per gate", () => {
    const gates = buildGates([
      check({ id: "g1", gate: "production_safety", state: "verified" }),
      check({ id: "g2", gate: "production_safety", state: "blocked", severity: "critical" }),
      check({ id: "g3", gate: "hardware_launch", state: "pending" }),
    ]);
    const safety = gates.find((g) => g.id === "production_safety")!;
    expect(safety.total).toBe(2);
    expect(safety.satisfied).toBe(1);
    expect(safety.worst).toBe("blocked");
    expect(safety.criticalOpen).toBe(1);
    const hw = gates.find((g) => g.id === "hardware_launch")!;
    expect(hw.worst).toBe("pending");
    const commercial = gates.find((g) => g.id === "commercial")!;
    expect(commercial.total).toBe(0);
    expect(commercial.worst).toBe("satisfied");
  });
});

describe("launchReadiness", () => {
  it("evaluates honestly with no database (all probes degrade, nothing fabricated)", async () => {
    const r = await launchReadiness(null);
    expect(r.checks.length).toBeGreaterThan(30);
    // No DB → DB-evidence checks must not claim verified.
    const dbVerified = r.checks.filter((c) => c.state === "verified" && c.evidenceKind === "live_db");
    expect(dbVerified).toHaveLength(0);
    // Every subsystem is represented.
    expect(r.subsystems).toHaveLength(14);
    // Blockers are deduplicated by check id.
    const ids = r.blockers.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Gates cover all four launch gates.
    expect(r.gates.map((g) => g.id).sort()).toEqual(
      ["commercial", "hardware_launch", "optional", "production_safety"],
    );
    // Summary totals reconcile.
    expect(r.summary.total).toBe(r.checks.length);
  }, 30000);
});
