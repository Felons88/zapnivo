import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../_shared";
import { requireElevation } from "@/lib/system/elevation";
import { systemAudit } from "@/lib/system/audit";
import { getSystemDevice, isUuid } from "@/lib/system/kiosks";
import {
  CERTIFICATION_CHECKS, CERTIFICATION_STATUSES, CERTIFICATION_TIERS,
  type CertificationTier,
} from "@/app/system/kiosks/certification/checklist";

/**
 * /api/system/kiosks/certification — hardware certification run ledger
 * (migration 0051, table system_certification_runs).
 *
 * GET  — list runs, latest-first. Filters: ?device_id=<uuid>&tier=<tier>&limit=<n≤200>.
 *        Permission: system.kiosks.view.
 * POST — record one check result. Permission: system.kiosks.manage.
 *        tier='physical' additionally requires a live step-up elevation
 *        (403 + code 'step_up_required' without fresh MFA — physical dispense
 *        tests move real hardware). simulated/gateway_contract do not.
 *
 * Tamper evidence: every insert computes record_hash = sha256(canonical JSON
 * of the row content) and links prev_hash to the previous run in the same
 * (device_id, tier) chain. See verifyCertificationChain below. This is
 * application-level evidence — DB-level append-only would be stronger
 * (documented in migration 0051).
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

export type CertificationRunRow = {
  id: string;
  device_id: string | null;
  tier: CertificationTier;
  check_key: string;
  status: string;
  detail: unknown;
  actor_id: string | null;
  created_at: string;
  record_hash: string;
  prev_hash: string | null;
};

/* ── Canonical JSON + hash chain (pure, testable) ────────────────────────── */

/** Deterministic JSON: object keys sorted recursively, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Content fields that feed record_hash — everything except id/record_hash itself. */
export type HashableRun = {
  device_id: string | null;
  tier: string;
  check_key: string;
  status: string;
  detail: unknown;
  actor_id: string | null;
  prev_hash: string | null;
  created_at: string;
};

export function certificationRecordHash(row: HashableRun): string {
  return createHash("sha256").update(canonicalJson({
    device_id: row.device_id ?? null,
    tier: row.tier,
    check_key: row.check_key,
    status: row.status,
    detail: row.detail ?? null,
    actor_id: row.actor_id ?? null,
    prev_hash: row.prev_hash ?? null,
    created_at: row.created_at,
  }), "utf8").digest("hex");
}

/**
 * Verifies hash chains. Accepts runs for ONE chain (same device_id+tier),
 * any order — they are sorted by created_at ascending internally. Returns the
 * index (in the sorted order) of the first broken link, or ok:true.
 *   - prev_hash must equal the previous run's record_hash (NULL only first).
 *   - record_hash must recompute from the stored content.
 */
export function verifyCertificationChain(runs: CertificationRunRow[]): { ok: boolean; brokenIndex?: number; reason?: string } {
  const sorted = [...runs].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  let prev: string | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if ((r.prev_hash ?? null) !== prev) {
      return { ok: false, brokenIndex: i, reason: i === 0 ? "unexpected_prev_hash" : "prev_hash_mismatch" };
    }
    if (certificationRecordHash(r) !== r.record_hash) {
      return { ok: false, brokenIndex: i, reason: "record_hash_mismatch" };
    }
    prev = r.record_hash;
  }
  return { ok: true };
}

/* ── Detail sanitization — no credential material in the ledger ──────────── */

const SENSITIVE_DETAIL_KEY = /pass|secret|token|key|auth|cookie|otp|card|cvv|ssn|credential|signature|seed/i;
const MAX_DETAIL_JSON = 8000;
const MAX_DETAIL_DEPTH = 4;

function sanitizeDetail(value: unknown, depth: number): unknown {
  if (depth > MAX_DETAIL_DEPTH) return "[truncated]";
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? value.slice(0, 500) : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeDetail(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    if (SENSITIVE_DETAIL_KEY.test(k)) continue; // drop credential-shaped keys entirely
    out[k] = sanitizeDetail(v, depth + 1);
  }
  return out;
}

/* ── Chain head lookup ───────────────────────────────────────────────────── */

async function latestRunHash(
  db: Parameters<typeof getSystemDevice>[0],
  deviceId: string | null,
  tier: CertificationTier,
): Promise<string | null> {
  let q = db
    .from("system_certification_runs")
    .select("record_hash,created_at")
    .eq("tier", tier)
    .order("created_at", { ascending: false })
    .limit(1);
  q = deviceId ? q.eq("device_id", deviceId) : q.is("device_id", null);
  const { data } = await q;
  const row = Array.isArray(data) ? (data[0] as { record_hash?: string } | undefined) : null;
  return row?.record_hash ?? null;
}

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

  const detail = input.detail == null ? null : sanitizeDetail(input.detail, 0);
  const detailJson = detail === null ? null : JSON.stringify(detail);
  if (detailJson && detailJson.length > MAX_DETAIL_JSON) {
    return NextResponse.json({ error: `detail too large (max ${MAX_DETAIL_JSON} chars after sanitization)` }, { status: 400 });
  }

  const createdAt = new Date().toISOString();
  const prevHash = await latestRunHash(g.db, deviceId, input.tier);
  const hashable: HashableRun = {
    device_id: deviceId,
    tier: input.tier,
    check_key: input.check_key,
    status: input.status,
    detail,
    actor_id: g.user.id,
    prev_hash: prevHash,
    created_at: createdAt,
  };
  const recordHash = certificationRecordHash(hashable);

  const { data, error } = await g.db
    .from("system_certification_runs")
    .insert({ ...hashable, record_hash: recordHash })
    .select("id,device_id,tier,check_key,status,detail,actor_id,created_at,record_hash,prev_hash")
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 500 });
  }

  await systemAudit(g.db, {
    actor: { id: g.user.id, role: g.role },
    action: "kiosk.certification_recorded",
    resource: deviceId ? `system_device:${deviceId}` : "kiosk_certification:fleet",
    detail: {
      tier: input.tier,
      check: input.check_key,
      status: input.status,
      device_id: deviceId,
      record_hash: recordHash,
      elevation: elevationMethod,
      // NOTE: simulated/gateway results are contract evidence only — never physical verification.
    },
  });

  return NextResponse.json({ run: data }, { status: 201 });
}
