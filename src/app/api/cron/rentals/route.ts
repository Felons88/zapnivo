import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { runRentalSweep } from "@/lib/email-triggers";
import { recordCron, runFleetSweep } from "@/lib/fleet-sweep";
import { runSmsSweep } from "@/lib/notifications";
import { generateLedgers, previousPeriod } from "@/lib/ledgers";
import { expireSweep } from "@/lib/monetization/entitlements";
import { serviceClient } from "@/lib/supabase";

/**
 * Daily sweep: rental deadline reminders + non-return notices, offline/low-battery fleet alerts,
 * stale command expiry. Authorized by CRON_SECRET (Vercel cron) or a signed-in staff user ("Run now").
 */
async function authorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") ?? "";
  const want = `Bearer ${secret ?? ""}`;
  if (secret && bearer.length === want.length && timingSafeEqual(Buffer.from(bearer), Buffer.from(want))) return true;
  return isStaff(await getSessionUser());
}

export async function GET(req: Request) {
  if (!(await authorized(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const rentals = await recordCron(db, "rentals", async () => ({ ...(await runRentalSweep()) }));
  const sms = await recordCron(db, "sms", async () => ({ ...(await runSmsSweep(db)) }));
  const fleet = await recordCron(db, "fleet", async () => ({ ...(await runFleetSweep(db)) }));
  const first = new Date().getUTCDate() === 1;
  const entitlements = await recordCron(db, "entitlements", async () => {
    const { expireSweep } = await import("@/lib/monetization/entitlements");
    const { releaseOrphanedReservations, expireStaleAuthorizedRentals } = await import("@/lib/monetization/credits");
    const stale = await expireStaleAuthorizedRentals(db);
    return { expired: await expireSweep(db), released: await releaseOrphanedReservations(db), stale };
  });
  const ledgers = first ? await recordCron(db, "ledgers", async () => { const r = await generateLedgers(db, previousPeriod()); return { created: r.created.length, noRate: r.skippedNoRate.length, locked: r.skippedLocked.length }; }) : null;
  const ok = rentals.ok && fleet.ok && sms.ok && entitlements.ok && (ledgers?.ok ?? true);
  return NextResponse.json({ ok, rentals: rentals.detail, sms: sms.detail, fleet: fleet.detail, entitlements: entitlements.detail, ledgers: ledgers?.detail ?? "not first of month" }, { status: ok ? 200 : 500 });
}
