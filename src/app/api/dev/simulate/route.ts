import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase";
import { KioskSimulator, createSimEnvironment, createSimRental } from "@/lib/kiosk/simulator";

/**
 * DEV-ONLY kiosk simulator driver — 404 in production.
 *
 *   GET  /api/dev/simulate            → dry-run: the event batches a sim kiosk
 *                                       would emit (no DB writes).
 *   POST /api/dev/simulate {execute}  → provisions a sim-namespace device +
 *                                       kiosk through the REAL libs
 *                                       (createSimEnvironment → provision
 *                                       token → redeem → HMAC credential),
 *                                       then drives heartbeat → inventory →
 *                                       dispense ack → return through
 *                                       SimDeviceSession (signed requests).
 *                                       Every emitted event carries
 *                                       simulated:true. Requires a configured
 *                                       Supabase backend (503 otherwise).
 *
 * Sim rows live in the sim- namespace (device_uid sim-…, station SIM-…,
 * capabilities.simulated=true) and never touch production device rows.
 */
const devOnly = () => process.env.NODE_ENV === "production";

export async function GET() {
  if (devOnly()) return new NextResponse("Not found", { status: 404 });
  const sim = new KioskSimulator("SIM-DRYRUN");
  sim.heartbeat();
  sim.slotState(1, "ready", "SIM-BANK-DRYRUN");
  sim.dispenseAck("sim-cmd-dryrun", { slot: 1, bankSerial: "SIM-BANK-DRYRUN" });
  sim.dockBank("SIM-BANK-DRYRUN", { slot: 1 });
  sim.flush();
  return NextResponse.json({
    simulated: true,
    note: "dry-run event plan — POST {execute:true} runs it against the real ingest pipeline (dev backend required)",
    batches: sim.batches,
  });
}

export async function POST(req: Request) {
  if (devOnly()) return new NextResponse("Not found", { status: 404 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  let body: { execute?: boolean } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty body = dry info */ }
  if (!body.execute) {
    return NextResponse.json({ ok: true, hint: "POST {\"execute\":true} to run the simulated lifecycle" });
  }

  try {
    const env = await createSimEnvironment(db);
    const rental = await createSimRental(db, env, { state: "payment_authorized" });
    const sim = new KioskSimulator(env.stationId);

    // 1. Heartbeat + inventory.
    const hb = await env.session.post([sim.heartbeat(new Date().toISOString())]);
    const inv = await env.session.post([
      sim.slotState(1, "ready", rental.bankSerial),
      sim.slotState(2, "empty"),
    ]);

    // 2. Dispense command → correlated ack → rental activated.
    const cmdKey = `sim-dev-dispatch-${Date.now()}`;
    await db.from("device_commands").insert({
      kiosk_id: env.kiosk.id, command: "unlock_slot", idempotency_key: cmdKey,
      payload: { rental_id: rental.rentalId, slot: 1 },
    });
    const ack = sim.dispenseAck(cmdKey, {
      slot: 1, bankSerial: rental.bankSerial, rentalRef: rental.reference,
      at: new Date().toISOString(),
    });
    const dispense = await env.session.post([ack]);

    // 3. Return: sensor detection + verified dock + command ack.
    const ret = await env.session.post([
      sim.returnDetected(rental.bankSerial, { slot: 1, rentalRef: rental.reference, at: new Date().toISOString() }),
    ]);
    const dock = sim.dockBank(rental.bankSerial, { slot: 1, at: new Date().toISOString(), rentalRef: rental.reference });
    const returned = await env.session.post([dock]);

    return NextResponse.json({
      simulated: true,
      device: { id: env.device.id, device_uid: env.deviceUid, station_id: env.stationId },
      rental: { id: rental.rentalId, reference: rental.reference },
      steps: {
        heartbeat: { status: hb.status, outcomes: hb.outcomes?.map((o) => o.result) },
        inventory: { status: inv.status, outcomes: inv.outcomes?.map((o) => o.result) },
        dispense_ack: { status: dispense.status, outcomes: dispense.outcomes?.map((o) => o.result) },
        return_detected: { status: ret.status, outcomes: ret.outcomes?.map((o) => o.result) },
        return_dock: { status: returned.status, outcomes: returned.outcomes?.map((o) => o.result) },
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "simulator run failed" }, { status: 500 });
  }
}
