import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { systemAudit } from "@/lib/system/audit";
import {
  KioskSimulator, createSimEnvironment, createSimRental,
} from "@/lib/kiosk/simulator";
import { runSimulatedSuite } from "@/lib/kiosk/certification-runner";

/**
 * POST /api/system/dev/simulate — staff-facing kiosk simulator console.
 *
 * Runs SYNTHETIC scenarios entirely inside the sim- namespace (sim- device
 * uids, SIM- stations, ZR-SIM- rental refs, capabilities.simulated=true) via
 * the REAL provisioning + ingest libs — the same code paths a physical kiosk
 * exercises, minus hardware. It can NEVER touch production device rows:
 * createSimEnvironment only inserts sim-namespaced rows, and SimDeviceSession
 * enforces the station binding + HMAC auth contract.
 *
 * Gated by system.kiosks.manage (a manage permission, not just view) and
 * rate-limited to 6 runs/min — each run provisions a fresh sim stack.
 * Every run is audited as dev.simulate.
 *
 * Scenarios:
 *   heartbeat          — provision sim kiosk, post heartbeat + slot states
 *   lifecycle          — full dispense → activate → return flow w/ real command ack
 *   duplicate_replay   — same signed batch + nonce posted twice (dedup check)
 *   auth_reject        — corrupted signature must be rejected (negative test)
 *   certification_suite— runSimulatedSuite: hash-chained certification ledger run
 */

const SCENARIOS = ["heartbeat", "lifecycle", "duplicate_replay", "auth_reject", "certification_suite"] as const;
const schema = z.object({
  scenario: z.enum(SCENARIOS),
});

const summarize = (r: { status: number; outcomes?: { result: string }[]; body: Record<string, unknown> }) => ({
  status: r.status,
  outcomes: r.outcomes?.map((o) => o.result) ?? null,
  error: typeof r.body.error === "string" ? r.body.error : null,
});

export async function POST(req: Request) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 6, windowMs: 60_000 });
  if (!g.ok) return g.res;

  const body = await readJson(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid scenario", scenarios: SCENARIOS }, { status: 400 });
  }
  const scenario = parsed.data.scenario;

  try {
    if (scenario === "certification_suite") {
      const suite = await runSimulatedSuite(g.db, { actorId: g.user.id });
      await systemAudit(g.db, {
        actor: { id: g.user.id, role: g.role },
        action: "dev.simulate",
        resource: "dev:simulate:certification_suite",
        detail: { ok: suite.ok, recorded: suite.recorded, refused: suite.refused === true },
      });
      return NextResponse.json({ simulated: true, scenario, suite });
    }

    const env = await createSimEnvironment(g.db);
    const sim = new KioskSimulator(env.stationId);

    if (scenario === "heartbeat") {
      const hb = await env.session.post([sim.heartbeat(new Date().toISOString())]);
      const inv = await env.session.post([
        sim.slotState(1, "ready", "SIM-BANK-HB"),
        sim.slotState(2, "empty"),
      ]);
      await systemAudit(g.db, {
        actor: { id: g.user.id, role: g.role },
        action: "dev.simulate",
        resource: `dev:simulate:${scenario}`,
        detail: { device_uid: env.deviceUid, station_id: env.stationId },
      });
      return NextResponse.json({
        simulated: true, scenario,
        device: { device_uid: env.deviceUid, station_id: env.stationId, id: env.device.id },
        steps: { heartbeat: summarize(hb), inventory: summarize(inv) },
      });
    }

    if (scenario === "lifecycle") {
      const rental = await createSimRental(g.db, env, { state: "payment_authorized" });
      const hb = await env.session.post([sim.heartbeat(new Date().toISOString())]);
      const inv = await env.session.post([sim.slotState(1, "ready", rental.bankSerial), sim.slotState(2, "empty")]);

      const cmdKey = `sim-console-dispatch-${Date.now()}`;
      await g.db.from("device_commands").insert({
        kiosk_id: env.kiosk.id, command: "unlock_slot", idempotency_key: cmdKey,
        payload: { rental_id: rental.rentalId, slot: 1 },
      });
      const ack = sim.dispenseAck(cmdKey, {
        slot: 1, bankSerial: rental.bankSerial, rentalRef: rental.reference,
        at: new Date().toISOString(),
      });
      const dispense = await env.session.post([ack]);

      const ret = await env.session.post([
        sim.returnDetected(rental.bankSerial, { slot: 1, rentalRef: rental.reference, at: new Date().toISOString() }),
      ]);
      const dock = sim.dockBank(rental.bankSerial, { slot: 1, at: new Date().toISOString(), rentalRef: rental.reference });
      const returned = await env.session.post([dock]);

      await systemAudit(g.db, {
        actor: { id: g.user.id, role: g.role },
        action: "dev.simulate",
        resource: `dev:simulate:${scenario}`,
        detail: { device_uid: env.deviceUid, station_id: env.stationId, rental_ref: rental.reference },
      });
      return NextResponse.json({
        simulated: true, scenario,
        device: { device_uid: env.deviceUid, station_id: env.stationId, id: env.device.id },
        rental: { id: rental.rentalId, reference: rental.reference },
        steps: {
          heartbeat: summarize(hb), inventory: summarize(inv),
          dispense_ack: summarize(dispense), return_detected: summarize(ret), return_dock: summarize(returned),
        },
      });
    }

    if (scenario === "duplicate_replay") {
      // Same event object + same dedup nonce posted twice — the second post
      // must be rejected by verifyDeviceAuth's nonce dedup (or honestly
      // recorded as a replay; either way we report what actually happened).
      const event = sim.heartbeat(new Date().toISOString());
      const nonce = `sim-console-nonce-${Date.now()}`.slice(0, 128);
      const first = await env.session.post([event], { messageId: nonce });
      const second = await env.session.post([sim.replay(event)], { messageId: nonce });
      await systemAudit(g.db, {
        actor: { id: g.user.id, role: g.role },
        action: "dev.simulate",
        resource: `dev:simulate:${scenario}`,
        detail: { device_uid: env.deviceUid, station_id: env.stationId, first: first.status, second: second.status },
      });
      return NextResponse.json({
        simulated: true, scenario,
        device: { device_uid: env.deviceUid, station_id: env.stationId, id: env.device.id },
        expectation: "second post with identical nonce should be rejected as a replay",
        steps: { first: summarize(first), replay: summarize(second) },
      });
    }

    // auth_reject — corrupted signature must fail verification.
    const bad = await env.session.post([sim.heartbeat(new Date().toISOString())], {
      signature: "deadbeef".repeat(8),
    });
    await systemAudit(g.db, {
      actor: { id: g.user.id, role: g.role },
      action: "dev.simulate",
      resource: `dev:simulate:${scenario}`,
      detail: { device_uid: env.deviceUid, station_id: env.stationId, status: bad.status },
    });
    return NextResponse.json({
      simulated: true, scenario,
      device: { device_uid: env.deviceUid, station_id: env.stationId, id: env.device.id },
      expectation: "forged signature must be rejected (401)",
      steps: { forged_signature: summarize(bad) },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "simulator run failed" }, { status: 500 });
  }
}
