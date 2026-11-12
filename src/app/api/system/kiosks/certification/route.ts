import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { requireElevation } from "@/lib/system/elevation";
import { systemAudit } from "@/lib/system/audit";
import { getSystemDevice, isUuid } from "@/lib/system/kiosks";
import {
  CERTIFICATION_CHECKS, CERTIFICATION_STATUSES, CERTIFICATION_TIERS,
} from "@/app/system/kiosks/certification/checklist";
import {
  canonicalJson, certificationRecordHash, recordCertificationRun,
  runPhysicalSuiteRefusal, runSimulatedSuite,
  verifyCertificationChain,
  type CertificationRunRecord, type HashableRun,
} from "@/lib/kiosk/certification-runner";

/**
 * /api/system/kiosks/certification — hardware certification run ledger
 * (migration 0051, table system_certification_runs).
 *
 * GET  — list runs, latest-first. Filters: ?device_id=<uuid>&tier=<tier>&limit=<n≤200>.
 *        Permission: system.kiosks.view.
 * POST — two actions:
 *   { action: "run_suite", device_id?, tier? } — runs the AUTOMATED suite
 *        (src/lib/kiosk/certification-runner.ts) against the real libs via the
 *        kiosk simulator and records every check through the same hash-chained
 *        path. tier 'simulated' (default) runs simulated + software-exercisable
 *        gateway_contract checks; tier 'physical' is REFUSED (physical requires
 *        the manual elevated flow below — nothing is recorded). Permission:
 *        system.kiosks.manage.
 *   { device_id?, tier, check_key, status, detail? } — record ONE manual run.
 *        tier='physical' additionally requires a live step-up elevation
 *        (403 + code 'step_up_required' without fresh MFA — physical dispense
 *        tests move real hardware). simulated/gateway_contract do not.
 *
 * Tamper evidence: every insert computes record_hash = sha256(canonical JSON
 * of the row content) and links prev_hash to the previous run in the same
 * (device_id, tier) chain. The chain helpers + recordCertificationRun live in
 * src/lib/kiosk/certification-runner.ts (shared with the suite runner) and are
 * re-exported here for compatibility. Application-level evidence — DB-level
 * append-only would be stronger (documented in migration 0051).
 */

const CHECK_KEYS = CERTIFICATION_CHECKS.map((c) => c.key) as [string, ...string[]];

export const certificationRunSchema = z.object({
  device_id: z.string().uuid().nullish(),
  tier: z.enum(CERTIFICATION_TIERS),
  check_key: z.enum(CHECK_KEYS),
  status: z.enum(CERTIFICATION_STATUSES),
  detail: z.record(z.string(), z.unknown()).nullish(),
});
export type CertificationRunInput = z.infer<typeof certificationRunSchema>;

export type CertificationRunRow = CertificationRunRecord & { id: string };

// Re-exported pure helpers — the canonical implementations live in
// certification-runner.ts so the suite runner and this route share ONE
// hash/record/sanitize path. Existing imports (tests) keep working.
export { canonicalJson, certificationRecordHash, verifyCertificationChain };
export type { HashableRun };

/* ── Handlers ────────────────────────────────────────────────────────────── */

export async function GET(req: Request) {
  const g = await systemApiGuard("system.kiosks.view", { limit: 120 });
  if (!g.ok) return g.res;

  const url = new URL(req.url);
  const deviceId = url.searchParams.get("device_id");
  const tier = url.searchParams.get("tier");
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 100;

  if (deviceId && !isUuid(deviceId)) {
    return NextResponse.json({ error: "device_id must be a uuid" }, { status: 400 });
  }
  if (tier && !(CERTIFICATION_TIERS as readonly string[]).includes(tier)) {
    return NextResponse.json({ error: `tier must be one of: ${CERTIFICATION_TIERS.join(", ")}` }, { status: 400 });
  }

  let q = g.db
    .from("system_certification_runs")
    .select("id,device_id,tier,check_key,status,detail,actor_id,created_at,record_hash,prev_hash")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (deviceId) q = q.eq("device_id", deviceId);
  if (tier) q = q.eq("tier", tier);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ runs: data ?? [], count: Array.isArray(data) ? data.length : 0 });
}

export async function POST(req: Request) {
  const g = await systemApiGuard("system.kiosks.manage", { limit: 30 });
  if (!g.ok) return g.res;

  const body = await readJson(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Automated suite action ──────────────────────────────────────────────
  if (body.action === "run_suite") {
    const tierRaw = typeof body.tier === "string" ? body.tier : "simulated";
    const deviceId = typeof body.device_id === "string" && body.device_id ? body.device_id : null;
    if (deviceId && !isUuid(deviceId)) {
      return NextResponse.json({ error: "device_id must be a uuid" }, { status: 400 });
    }
    if (tierRaw === "physical") {
      // Honest refusal — physical certification is NEVER automated. Nothing
      // is recorded; the caller gets blocked results + guidance.
      const refusal = await runPhysicalSuiteRefusal();
      return NextResponse.json({ ...refusal, hint: "Record physical runs individually with tier='physical' + step-up elevation." }, { status: 409 });
    }
    if (tierRaw !== "simulated") {
      return NextResponse.json({ error: `run_suite supports tier 'simulated' only (got '${tierRaw}')` }, { status: 400 });
    }
    const suite = await runSimulatedSuite(g.db, { deviceId, actorId: g.user.id });
    await systemAudit(g.db, {
      actor: { id: g.user.id, role: g.role },
      action: "kiosk.certification_suite_run",
      resource: suite.device_id ? `system_device:${suite.device_id}` : "kiosk_certification:fleet",
      detail: {
        suite_run_id: suite.suite_run_id,
        device_id: suite.device_id,
        simulated: true,
        recorded: suite.recorded,
        results: suite.results.map((r) => ({ check: r.check_key, tier: r.tier, status: r.status, recorded: r.recorded })),
      },
    });
    return NextResponse.json(suite, { status: suite.ok ? 200 : 207 });
  }

  // ── Manual single-run record ────────────────────────────────────────────
  const parsed = certificationRunSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid certification run", issues: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "body"}: ${i.message}`) },
      { status: 400 },
    );
  }
  const input = parsed.data;
  const deviceId = input.device_id ?? null;

  // Physical tier moves/observes real hardware — require fresh step-up (MFA).
  let elevationMethod: string | null = null;
  if (input.tier === "physical") {
    const elev = await requireElevation(g.db, g.user);
    if (!elev.ok) {
      return NextResponse.json({ error: elev.error, code: elev.code }, { status: elev.status });
    }
    elevationMethod = elev.method;
  }

  if (deviceId) {
    const device = await getSystemDevice(g.db, deviceId);
    if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const rec = await recordCertificationRun(g.db, {
    device_id: deviceId,
    tier: input.tier,
    check_key: input.check_key,
    status: input.status,
    detail: input.detail ?? null,
  }, g.user.id);
  if (!rec.ok) {
    return NextResponse.json({ error: rec.error }, { status: rec.status });
  }
  const run = rec.run;

  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "kiosk.certification_recorded",
    resource: deviceId ? `system_device:${deviceId}` : "kiosk_certification:fleet",
    detail: {
      tier: input.tier,
      check: input.check_key,
      status: input.status,
      device_id: deviceId,
      record_hash: run.record_hash,
      elevation: elevationMethod,
      // NOTE: simulated/gateway results are contract evidence only — never physical verification.
    },
  });

  return NextResponse.json({ run }, { status: 201 });
}
