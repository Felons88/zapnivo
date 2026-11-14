/**
 * Kiosk update SIMULATOR — scenario engine for tests and the dev console.
 *
 * ⚠️  SIMULATION ONLY.  ⚠️
 *
 * Everything produced here is ILLUSTRATIVE: the state sequences below model
 * what a real update *might* look like, but NO physical kiosk is contacted,
 * NO bytes are flashed, and NO telemetry is real. Every result object carries
 * `simulated: true` and the notes say so explicitly.
 *
 * This module NEVER writes to the database on its own. `persistSimulatedRun`
 * exists for the dev console/tests and stamps every written row's result with
 * `simulated: true` so simulated evidence can never be mistaken for device
 * telemetry — and it is only reachable from dev/test code paths, never from
 * production routes.
 */

export const SIMULATED = true as const;

export type SimScenarioName =
  | "success"
  | "lost_connection"
  | "failed_download"
  | "duplicate_update"
  | "version_mismatch"
  | "unsupported_firmware"
  | "interrupted"
  | "unsupported_rollback";

export const SIM_SCENARIOS: readonly SimScenarioName[] = [
  "success", "lost_connection", "failed_download", "duplicate_update",
  "version_mismatch", "unsupported_firmware", "interrupted", "unsupported_rollback",
];

export type SimTransition = {
  /** Target state entered (mirrors kiosk_update_targets.state values). */
  state: string;
  /** Simulated dwell time in that state, ms. */
  dwell_ms: number;
  note?: string;
};

export type SimScenarioResult = {
  scenario: SimScenarioName;
  /** Ordered state walk the simulated device would take. */
  states: SimTransition[];
  /** Terminal/holding state the simulation ends in. */
  finalState: string;
  simulated: true;
  notes: string[];
};

export type SimOptions = {
  /** Simulated starting firmware version reported by the "device". */
  fromVersion?: string;
  /** Simulated target release version. */
  toVersion?: string;
  /** Deterministic-ish seed for dwell jitter (tests pass fixed values). */
  seed?: number;
};

const BASE_NOTES = [
  "SIMULATION ONLY — no physical device was contacted and no bytes were transferred.",
  "State names mirror kiosk_update_targets.state but timings/outcomes are invented for testing and UI demonstration.",
];

function seq(scenario: SimScenarioName, finalState: string, states: SimTransition[], extraNotes: string[] = []): SimScenarioResult {
  return { scenario, states, finalState, simulated: SIMULATED, notes: [...BASE_NOTES, ...extraNotes] };
}

/**
 * Runs one named scenario. Pure function — no I/O, no DB, fully deterministic
 * when `seed` is fixed (dwell times are illustrative, not random in practice).
 */
export function simulateUpdateScenario(name: SimScenarioName, opts: SimOptions = {}): SimScenarioResult {
  const from = opts.fromVersion ?? "1.4.2";
  const to = opts.toVersion ?? "1.5.0";
  const j = (n: number) => n; // dwell jitter hook — kept deterministic

  switch (name) {
    case "success":
      return seq(name, "completed", [
        { state: "queued", dwell_ms: j(500) },
        { state: "transferring", dwell_ms: j(45_000), note: "artifact download 100%" },
        { state: "installing", dwell_ms: j(90_000), note: "signature verified, flash written" },
        { state: "reconnecting", dwell_ms: j(20_000), note: "device rebooted, heartbeat resumed" },
        { state: "verifying", dwell_ms: j(10_000), note: `reported firmware_version=${to}` },
        { state: "completed", dwell_ms: 0, note: "verification evidence accepted" },
      ], [`Simulated ${from} → ${to} with verified post-update telemetry.`]);

    case "lost_connection":
      return seq(name, "unknown_outcome", [
        { state: "queued", dwell_ms: j(500) },
        { state: "transferring", dwell_ms: j(30_000), note: "download stalls at 62%" },
        { state: "unknown_outcome", dwell_ms: 0, note: "heartbeat lost mid-transfer — device state unknowable; campaign would auto-block" },
      ], ["Device went silent mid-transfer. Real handling: unknown_outcome → investigating, campaign auto-blocks (no auto-retry)."]);

    case "failed_download":
      return seq(name, "failed", [
        { state: "queued", dwell_ms: j(500) },
        { state: "transferring", dwell_ms: j(20_000) },
        { state: "failed", dwell_ms: 0, note: "checksum mismatch on artifact — device refused to flash; safe rollback to previous version" },
      ], ["Artifact integrity check failed BEFORE flashing — device unchanged."]);

    case "duplicate_update":
      return seq(name, "completed", [
        { state: "queued", dwell_ms: j(500), note: "idempotency key already seen — gateway returns prior ack" },
        { state: "completed", dwell_ms: 0, note: "duplicate suppressed; device already at target version" },
      ], ["Simulates commandId idempotency: a retried dispatch must not double-flash."]);

    case "version_mismatch":
      return seq(name, "investigating", [
        { state: "queued", dwell_ms: j(500) },
        { state: "transferring", dwell_ms: j(45_000) },
        { state: "installing", dwell_ms: j(90_000) },
        { state: "reconnecting", dwell_ms: j(20_000) },
        { state: "verifying", dwell_ms: j(10_000), note: `device reports ${from} instead of ${to}` },
        { state: "investigating", dwell_ms: 0, note: "reported version ≠ release version — verification refused, human review required" },
      ], ["Post-update telemetry contradicts the release — target can NEVER reach 'completed' on this evidence."]);

    case "unsupported_firmware":
      return seq(name, "failed", [
        { state: "queued", dwell_ms: j(500) },
        { state: "failed", dwell_ms: 0, note: "device rejected artifact: hw_revision below release.hw_revision_min / unsigned payload" },
      ], ["Compatibility gate failure — the campaign's resolveUpdateTargets should have excluded this device; this simulates a race (device changed after targeting)."]);

    case "interrupted":
      return seq(name, "recovery", [
        { state: "queued", dwell_ms: j(500) },
        { state: "transferring", dwell_ms: j(45_000) },
        { state: "installing", dwell_ms: j(40_000), note: "power loss mid-flash" },
        { state: "recovery", dwell_ms: 0, note: "device booted recovery partition; rollback to previous release required via NEW campaign — never automatic" },
      ], ["Interrupted flash → 'recovery' state. Rollback is a separate approved campaign against the previous release; nothing auto-retries."]);

    case "unsupported_rollback":
      return seq(name, "failed", [
        { state: "recovery", dwell_ms: j(1_000), note: "attempting rollback to previous release" },
        { state: "failed", dwell_ms: 0, note: "rollback artifact unsigned / not approved for this device — refused before flashing" },
      ], ["A rollback is just another campaign: it needs an APPROVED previous release. There is no privileged auto-rollback path."]);

    default:
      return seq(name as SimScenarioName, "failed",
        [{ state: "failed", dwell_ms: 0, note: `unknown scenario '${String(name)}'` }],
        ["Unknown scenario name."]);
  }
}

/** All scenarios at once — handy for the dev console grid. */
export function simulateAllScenarios(opts: SimOptions = {}): SimScenarioResult[] {
  return SIM_SCENARIOS.map((s) => simulateUpdateScenario(s, opts));
}

/* ── Optional persistence (dev/test only) ────────────────────────────────── */

/**
 * Writes a simulated run onto a REAL kiosk_update_targets row — dev console /
 * tests ONLY. Every write stamps result.simulated=true plus the scenario name
 * so simulated evidence is unmistakable and can never satisfy
 * verifyTargetCompletion (which requires device-reported version + fresh
 * heartbeat from system_devices, not self-asserted result fields).
 *
 * Returns the final written state. This function performs NO hardware calls.
 */
export async function persistSimulatedRun(
  db: { from: (t: string) => unknown },
  targetId: string,
  scenario: SimScenarioName,
  opts: SimOptions = {},
): Promise<{ ok: boolean; state?: string; error?: string }> {
  const run = simulateUpdateScenario(scenario, opts);
  try {
    // Walk the simulated states onto the row, capped at the final state.
    const qb = db.from("kiosk_update_targets") as {
      update: (p: Record<string, unknown>) => { eq: (c: string, v: string) => Promise<{ error?: { message?: string } | null }> };
    };
    const res = await qb.update({
      state: run.finalState === "completed" ? "investigating" : run.finalState, // never fake 'completed'
      last_error: `simulated:${scenario}`,
      result: {
        simulated: true,
        scenario,
        simulated_states: run.states,
        simulated_final_state: run.finalState,
        note: "SIMULATED RUN — not device telemetry. Written by update-simulator for dev/test only.",
      },
    }).eq("id", targetId);
    if (res.error) return { ok: false, error: res.error.message ?? "update failed" };
    return { ok: true, state: run.finalState };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "persist failed" };
  }
}
