import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COMMAND_SELECT, OPEN_COMMAND_STATES, queueCommand, type CommandRow,
} from "./commands";
import {
  DISPENSE_CONFIRM_TYPES, DISPENSE_FAIL_TYPES, DISPENSE_REQUEST_TYPES, FAULT_TYPES,
} from "./lifecycle";
import { ingestKioskEvents, type IngestBody } from "./ingest";
import { recordLog } from "../observability";

async function kioskAudit(db: SupabaseClient, action: string, kioskId: string, detail: Record<string, unknown>) {
  await db.from("audit_logs").insert({ actor: null, action, entity: "kiosk", entity_id: kioskId, detail });
}

/**
 * Rental → hardware dispatch. Issues ONE durable `dispense` command per paid
 * rental (idempotency_key `dispense:{rental.id}` — retries are safe no-ops) and,
 * for staff-flagged test_mode kiosks, attaches a staged simulation plan that is
 * advanced through the REAL ingest pipeline (ingestKioskEvents → lifecycle) so
 * the full checkout → command → ack → activation loop runs without hardware.
 *
 * Delivery:
 *  - Physical kiosks: the command is queued for the device transport. Until a
 *    real adapter is wired (KIOSK_ADAPTER=none today) it expires into
 *    `unknown_outcome` → reconciliation — never auto-retried (a lost ack is NOT
 *    a failed dispense).
 *  - Test kiosks: `payload.sim` schedules synthetic events emitted with
 *    `simulated: true`. advanceSimDispenses() runs them on their server-clock
 *    schedule; it is invoked opportunistically from the mobile rentals poll and
 *    from the cron sweep, so no separate worker is required.
 *
 * Customer-facing stage mapping (dispenseStatusFor) derives the normalized
 * contract — connecting → verifying → preparing → releasing → dispensing →
 * almost_ready → ready | failed | checking — from durable command/event rows
 * only. Nothing here trusts client input or animation state.
 */

export const SIM_SCENARIOS = [
  "success", "offline", "jam", "timeout", "empty",
  "delayed_ack", "duplicate_ack", "partial", "lost_ack",
] as const;
export type SimScenario = (typeof SIM_SCENARIOS)[number];

/** Normalized customer-facing dispense stage (drives the app animation). */
export type DispenseStage =
  | "connecting" | "verifying" | "preparing" | "releasing"
  | "dispensing" | "almost_ready" | "ready" | "failed" | "checking";

type SimStageEvent = {
  offset_ms: number;
  type: string;
  outcome?: "acknowledged" | "failed" | "rejected" | "detected" | "released";
  error_code?: string;
  slot_state?: "empty" | "charging" | "ready" | "fault";
};

type SimPlan = {
  scenario: SimScenario;
  slot: number;
  next_index: number;
  next_at: string;
  bank_serial: string;
  stages: SimStageEvent[];
};

const VALID_SCENARIO = (s: unknown): s is SimScenario => typeof s === "string" && (SIM_SCENARIOS as readonly string[]).includes(s);

const ACK_ALL = [...DISPENSE_REQUEST_TYPES, ...DISPENSE_CONFIRM_TYPES, ...DISPENSE_FAIL_TYPES, ...FAULT_TYPES];

/** Stage offsets chosen to read like a real eject cycle (~9.5s) for demos.
 *  Contract honesty: `dispense_acknowledged`/`bank_released` are CONFIRM types
 *  (they activate the rental) — intermediate stages use `dispense_requested`
 *  (command accepted) and the informational `dispense_ejecting` /
 *  `dispense_almost_ready` types, which lifecycle records but never acts on. */
function buildSimPlan(scenario: SimScenario, now: Date): SimPlan {
  const serial = `SIM-BANK-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
  const base: SimStageEvent[] = [
    { offset_ms: 1500, type: "dispense_requested", outcome: "acknowledged" },
    { offset_ms: 4500, type: "dispense_ejecting" },
    { offset_ms: 6500, type: "dispense_almost_ready" },
    { offset_ms: 9500, type: "bank_released", outcome: "released", slot_state: "empty" },
  ];
  let stages: SimStageEvent[];
  switch (scenario) {
    case "jam":
      stages = [base[0], base[1], { offset_ms: 7000, type: "dispense_failed", outcome: "failed", error_code: "slot_jam" }];
      break;
    case "empty":
      stages = [{ offset_ms: 2000, type: "dispense_failed", outcome: "failed", error_code: "no_inventory" }];
      break;
    case "offline": // device never picks the command up — expires → unknown_outcome
      stages = [];
      break;
    case "timeout": // device accepted the command, eject never confirmed
      stages = [base[0]];
      break;
    case "delayed_ack":
      stages = base.map((s) => ({ ...s, offset_ms: s.offset_ms * 3 }));
      break;
    case "duplicate_ack":
      stages = [...base, { offset_ms: 11000, type: "bank_released", outcome: "released" }];
      break;
    case "partial":
      stages = [base[0], base[1], { offset_ms: 7000, type: "dispense_failed", outcome: "failed", error_code: "partial_dispense" }];
      break;
    case "lost_ack": // commanded + ejecting reported, release never heard — NOT resent
      stages = [base[0], base[1], base[2]];
      break;
    default:
      stages = base;
  }
  return { scenario, slot: 1, next_index: 0, next_at: stages.length ? new Date(now.getTime() + stages[0].offset_ms).toISOString() : new Date(8.64e15).toISOString(), bank_serial: serial, stages };
}

/**
 * Issues the rental's dispense command. Idempotent: the unique
 * `dispense:{rental_id}` key makes repeat calls (webhook replays, sweep
 * catch-ups) safe no-ops. Only fires for `dispense_pending` rentals — payment
 * must already be verified server-side.
 */
export async function issueDispenseCommand(
  db: SupabaseClient,
  rentalId: string,
  opts: { now?: Date } = {},
): Promise<{ ok: boolean; commandId?: string; duplicate?: boolean; reason?: string }> {
  const now = opts.now ?? new Date();
  const { data: rental } = await db.from("rentals")
    .select("id,reference,state,kiosk_id,bank_count")
    .eq("id", rentalId).maybeSingle();
  if (!rental) return { ok: false, reason: "rental_not_found" };
  if (rental.state !== "dispense_pending" && rental.state !== "payment_authorized") {
    return { ok: false, reason: `state_${rental.state}` };
  }
  const { data: kiosk } = await db.from("kiosks")
    .select("id,station_id,state,test_mode,test_scenario")
    .eq("id", rental.kiosk_id).maybeSingle();
  if (!kiosk) return { ok: false, reason: "kiosk_not_found" };

  const testMode = kiosk.test_mode === true;
  const scenario: SimScenario = VALID_SCENARIO(kiosk.test_scenario) ? kiosk.test_scenario : "success";
  const sim = testMode ? buildSimPlan(scenario, now) : null;

  const res = await queueCommand(db, {
    kioskId: kiosk.id as string,
    command: "dispense",
    issuedBy: null,
    key: `dispense:${rental.id}`,
    payload: {
      rental_id: rental.id, rental_ref: rental.reference,
      bank_count: (rental.bank_count as number) ?? 1,
      station_id: kiosk.station_id,
      ...(sim ? { sim } : {}),
    },
    expectedResponseTypes: ACK_ALL,
    now,
  });
  if (res.duplicate) return { ok: true, duplicate: true };
  await kioskAudit(db, "kiosk.dispense_command_issued", kiosk.id as string, {
    command_id: res.id, rental_id: rental.id, rental_ref: rental.reference,
    test_mode: testMode, ...(sim ? { sim_scenario: sim.scenario } : {}),
  });
  recordLog("info", "dispense_command_issued", {
    service: "rentals", attrs: { commandId: res.id, rentalId: rental.id, testMode, scenario: sim?.scenario ?? null },
  });
  return { ok: true, commandId: res.id };
}

/**
 * Advances due stages of test-kiosk sim plans through the REAL ingest pipeline.
 * Each due stage becomes a signed-shape ingest event (simulated: true) so the
 * lifecycle's ack handling, slot projection, exceptions and audit all exercise
 * the same code a physical kiosk would hit. Silent scenarios (offline /
 * timeout / lost_ack) intentionally stall — the command then expires into
 * unknown_outcome, which is the honest "we don't know" state, never a resend.
 */
export async function advanceSimDispenses(
  db: SupabaseClient,
  now = new Date(),
): Promise<{ advanced: number; emitted: number }> {
  // Filter sim plans in JS rather than a JSON-path PostgREST filter so the
  // behaviour is identical against real Supabase and the in-memory test harness.
  const { data: cmds } = await db.from("device_commands")
    .select(COMMAND_SELECT)
    .eq("command", "dispense")
    .in("status", [...OPEN_COMMAND_STATES])
    .limit(50);
  let advanced = 0, emitted = 0;
  for (const cmd of (cmds ?? []) as unknown as CommandRow[]) {
    const payload = (cmd.payload ?? {}) as Record<string, unknown>;
    const sim = payload.sim as SimPlan | undefined;
    if (!sim || !Array.isArray(sim.stages) || sim.next_index >= sim.stages.length) continue;
    if (typeof sim.next_at !== "string" || sim.next_at > now.toISOString()) continue;

    const stage = sim.stages[sim.next_index];
    const { data: kiosk } = await db.from("kiosks").select("id,station_id,state").eq("id", cmd.kiosk_id).maybeSingle();
    if (!kiosk) continue;

    const body: IngestBody = {
      station_id: String(kiosk.station_id ?? payload.station_id ?? ""),
      events: [{
        type: stage.type,
        slot: sim.slot,
        slot_state: stage.slot_state,
        power_bank_serial: stage.type === "bank_released" ? sim.bank_serial : undefined,
        // Wire-level correlation id is the idempotency key — the same key a
        // physical kiosk echoes back on its acks.
        command_id: cmd.idempotency_key,
        rental_ref: (payload.rental_ref as string) ?? undefined,
        outcome: stage.outcome,
        error_code: stage.error_code,
        hw_timestamp: now.toISOString(),
        at: now.toISOString(),
        simulated: true,
      }],
    };
    try {
      await ingestKioskEvents(db, kiosk as { id: string; state?: string }, body, now);
      emitted += 1;
    } catch (e) {
      recordLog("warning", "sim_dispense_stage_failed", {
        service: "kiosk-sim", attrs: { commandId: cmd.id, stage: stage.type, err: e instanceof Error ? e.message : "unknown" },
      });
      continue;
    }

    const nextIndex = sim.next_index + 1;
    const next = sim.stages[nextIndex];
    const createdMs = cmd.created_at ? Date.parse(cmd.created_at) : now.getTime();
    const nextAt = next ? new Date(createdMs + next.offset_ms).toISOString() : new Date(8.64e15).toISOString();
    await db.from("device_commands")
      .update({ payload: { ...payload, sim: { ...sim, next_index: nextIndex, next_at: nextAt } } })
      .eq("id", cmd.id);
    advanced += 1;
  }
  return { advanced, emitted };
}

/**
 * Catch-up sweep: issues missing dispense commands for rentals stuck in
 * `dispense_pending` (e.g. webhook-time dispatch failure) and advances due sim
 * stages. Idempotent — the unique command key prevents double issuance.
 */
export async function runDispenseSweep(
  db: SupabaseClient,
  now = new Date(),
): Promise<{ issued: number; advanced: number }> {
  const stale = new Date(now.getTime() - 30_000).toISOString();
  const { data: rentals } = await db.from("rentals")
    .select("id")
    .eq("state", "dispense_pending")
    .lt("created_at", stale)
    .limit(25);
  let issued = 0;
  for (const r of (rentals ?? []) as { id: string }[]) {
    try {
      const res = await issueDispenseCommand(db, r.id, { now });
      if (res.ok && !res.duplicate) issued += 1;
    } catch { /* next sweep retries */ }
  }
  const { advanced } = await advanceSimDispenses(db, now);
  return { issued, advanced };
}

/* ───────────────────────── customer-facing stage ───────────────────────── */

/** device_events type → normalized stage (later rows win — ordered desc).
 *  Confirm types (dispense_acknowledged, bank_released) jump straight to
 *  `ready`: in this contract an ack IS hardware confirmation, not a progress
 *  hint. Intermediate informational types read like motor progress. */
const EVENT_STAGE: Record<string, DispenseStage> = {
  bank_released: "ready",
  dispense_acknowledged: "ready",
  dispense_almost_ready: "almost_ready",
  dispense_ejecting: "dispensing",
  dispense_requested: "releasing",
  dispense_failed: "failed",
  hardware_fault: "failed",
};

export type DispenseStatus = {
  stage: DispenseStage;
  slot: number | null;
  errorCode: string | null;
  simulated: boolean;
  commandStatus: string | null;
  updatedAt: string | null;
};

/**
 * Authoritative stage for one rental, derived from durable command + event
 * rows. Never regresses: `active` is always `ready`, and terminal command
 * failure kinds map to `failed`/`checking` rather than stale loading states.
 */
export async function dispenseStatusFor(
  db: SupabaseClient,
  rental: { id: string; state: string; kiosk_id?: string | null },
): Promise<DispenseStatus> {
  if (rental.state === "active") {
    return { stage: "ready", slot: null, errorCode: null, simulated: false, commandStatus: null, updatedAt: null };
  }
  if (rental.state !== "dispense_pending" && rental.state !== "payment_authorized") {
    return { stage: "connecting", slot: null, errorCode: null, simulated: false, commandStatus: null, updatedAt: null };
  }

  // JS-side rental matching keeps behaviour identical under the in-memory
  // test harness (its .filter() ignores JSON-path selectors).
  const { data: cmds } = await db.from("device_commands")
    .select(COMMAND_SELECT)
    .eq("command", "dispense")
    .order("created_at", { ascending: false })
    .limit(50);
  const command = ((cmds ?? []) as unknown as CommandRow[]).find(
    (c) => (c.payload as Record<string, unknown> | null)?.rental_id === rental.id,
  ) ?? null;
  if (!command) {
    return { stage: "verifying", slot: null, errorCode: null, simulated: false, commandStatus: null, updatedAt: null };
  }

  const { data: evs } = await db.from("device_events")
    .select("event_type,occurred_at,payload")
    .eq("kiosk_id", command.kiosk_id)
    .order("occurred_at", { ascending: false })
    .limit(50);
  const events = ((evs ?? []) as { event_type: string; occurred_at: string; payload: Record<string, unknown> | null }[])
    .filter((e) => e.payload?.command_id === command.id || e.payload?.command_id === command.idempotency_key)
    .slice(0, 10);

  let stage: DispenseStage | null = null;
  let errorCode: string | null = null;
  let slot: number | null = null;
  for (const e of events) {
    const mapped = EVENT_STAGE[e.event_type];
    if (!mapped) continue;
    stage = mapped;
    errorCode = (e.payload?.error_code as string) ?? null;
    slot = (e.payload?.slot as number) ?? ((command.payload?.sim as SimPlan | undefined)?.slot ?? null);
    break;
  }

  const simulated = (command.payload?.sim as SimPlan | undefined) != null
    || events.some((e) => e.payload?.simulated === true);

  if (stage === null) {
    if (OPEN_COMMAND_STATES.has(command.status)) {
      stage = command.status === "queued" ? "preparing" : "releasing";
    } else if (command.status === "acknowledged" || command.status === "confirmed") {
      stage = "ready";
    } else if (command.status === "failed" || command.status === "cancelled") {
      stage = "failed";
      errorCode = command.resolved_outcome ?? "command_failed";
    } else {
      // timeout | expired | unknown_outcome | requires_investigation — we do
      // NOT know what the hardware did; customer waits for verification.
      stage = "checking";
    }
  }

  return {
    stage,
    slot,
    errorCode,
    simulated,
    commandStatus: command.status,
    updatedAt: events[0]?.occurred_at ?? command.last_transition_at ?? command.created_at ?? null,
  };
}
