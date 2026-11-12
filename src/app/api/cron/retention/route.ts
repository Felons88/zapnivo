import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase";
import { runRetention } from "@/lib/system/retention";
import { sweepExpiredRotations } from "@/lib/system/device-auth";
import { recordLog, traced } from "@/lib/observability";

/**
 * Automated retention sweep (Vercel cron, daily — see vercel.json).
 * Auth: Bearer CRON_SECRET or a signed-in staff user ("Run now" from the UI).
 *
 * Runs EXECUTE mode by default — that is the point of the scheduled job.
 * `?dry_run=1` (or `?mode=dry_run`) performs a count-only verification pass.
 * `?table=<name>` restricts the sweep to one policy table.
 * `?limit=<n>` caps per-table batch size (default 500, max 5000).
 *
 * Preserved-class tables (audit, legal, financial, identity) are structurally
 * unreachable — runRetention refuses them even if asked.
 */
async function authorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const bearer = req.headers.get("authorization") ?? "";
  const want = `Bearer ${secret}`;
  return bearer.length === want.length && timingSafeEqual(Buffer.from(bearer), Buffer.from(want));
}

export async function GET(req: Request) {
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const staff = await import("@/lib/auth").then((m) => m.getSessionUser().then((u) => m.isStaff(u))).catch(() => false);
  if (!(await authorized(req)) && !staff) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const dryRun = params.get("dry_run") === "1" || params.get("mode") === "dry_run";
  const table = params.get("table") ?? undefined;
  const limit = params.get("limit") ? parseInt(params.get("limit")!, 10) : undefined;

  const report = await traced("cron.retention", null, () =>
    runRetention(db, { dryRun, table, limit, actor: null }),
  { dryRun, table: table ?? "all" });

  // Credential-rotation safety sweep — NOT part of runRetention (that sweep is
  // approval-gated destructive deletion; this only clears dead staged next-slot
  // fields on system_devices and audits each clear). Skipped on dry runs.
  const rotationSweep = dryRun
    ? { ok: true, swept: 0, skipped: "dry_run" as const }
    : await sweepExpiredRotations(db);

  // Record the outcome in cron_runs so Jobs & workers / status surfaces see it.
  await db.from("cron_runs").insert({
    job: "retention",
    ok: report.ok,
    detail: {
      mode: dryRun ? "dry_run" : "execute",
      deleted: report.results.reduce((a, r) => a + r.deleted, 0),
      matched: report.results.reduce((a, r) => a + r.matched, 0),
      tables: report.results.length,
      run_id: report.runId,
      credential_rotation_sweep: rotationSweep,
      error: report.error ?? undefined,
    },
  }).then(() => undefined, () => undefined);

  recordLog(report.ok ? "info" : "warning", `cron.retention ${dryRun ? "dry_run" : "execute"}`, {
    service: "cron",
    attrs: { deleted: report.results.reduce((a, r) => a + r.deleted, 0), ok: report.ok },
  });

  return NextResponse.json({ ok: report.ok && rotationSweep.ok !== false, report, credential_rotation_sweep: rotationSweep }, { status: report.ok ? 200 : 207 });
}
