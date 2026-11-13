import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase";
import { runRetention } from "@/lib/system/retention";
import { sweepExpiredRotations } from "@/lib/system/device-auth";
import { runAlertSweep } from "@/lib/system/alert-sweep";
import { recordCron } from "@/lib/fleet-sweep";
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

  // recordCron writes the cron_runs row AND emails staff when the job throws —
  // a broken sweep is never silent (D1/D2). Partial failures (report.ok ===
  // false, e.g. per-table errors) are re-thrown inside the job so they also
  // alert; the thrown message stays short because the full report is returned
  // in the response and persisted in system_retention_runs.
  let report: Awaited<ReturnType<typeof runRetention>> | undefined;
  let rotationSweep: { ok: boolean; swept: number; skipped?: string; error?: string } | undefined;
  let alertSweep: { ok: boolean; emitted: number; checks: Record<string, unknown>; skipped?: string; error?: string } | undefined;
  const cron = await recordCron(db, "retention", async () => {
    report = await traced("cron.retention", null, () =>
      runRetention(db, { dryRun, table, limit, actor: null }),
    { dryRun, table: table ?? "all" });

    // Credential-rotation safety sweep — NOT part of runRetention (that sweep is
    // approval-gated destructive deletion; this only clears dead staged next-slot
    // fields on system_devices and audits each clear). Skipped on dry runs.
    rotationSweep = dryRun
      ? { ok: true, swept: 0, skipped: "dry_run" }
      : await sweepExpiredRotations(db);

    // Phase 2.5 alert sweep — emits reportError warnings for unresolved rental
    // exceptions, stuck device commands, pending settlements, stale device
    // heartbeats and degraded integrations (ALERT_POLICY rules). Read-only
    // probes; skipped on dry runs and internally fault-tolerant (missing tables
    // → 'skipped', never throws).
    alertSweep = dryRun
      ? { ok: true, emitted: 0, checks: {}, skipped: "dry_run" }
      : await runAlertSweep(db).catch((e) => ({
          ok: false,
          emitted: 0,
          checks: {},
          error: e instanceof Error ? e.message : "alert sweep failed",
        }));

    const ok = report.ok && rotationSweep.ok !== false;
    const detail = {
      mode: dryRun ? "dry_run" : "execute",
      deleted: report.results.reduce((a, r) => a + r.deleted, 0),
      matched: report.results.reduce((a, r) => a + r.matched, 0),
      tables: report.results.length,
      run_id: report.runId,
      credential_rotation_sweep: rotationSweep,
      alert_sweep: alertSweep,
    };
    if (!ok) {
      const errs = report.results.filter((r) => r.error && !r.skipped).map((r) => `${r.table}: ${r.error}`).join("; ").slice(0, 300);
      throw new Error(`retention ${dryRun ? "dry_run" : "execute"} failed — ${report.error ?? errs ?? "unknown"}`);
    }
    return detail;
  });

  recordLog(cron.ok ? "info" : "warning", `cron.retention ${dryRun ? "dry_run" : "execute"}`, {
    service: "cron",
    attrs: { deleted: report?.results.reduce((a, r) => a + r.deleted, 0) ?? 0, ok: cron.ok },
  });

  return NextResponse.json({
    ok: cron.ok,
    report,
    credential_rotation_sweep: rotationSweep,
    alert_sweep: alertSweep,
    cron: cron.detail,
  }, { status: cron.ok ? 200 : 207 });
}
