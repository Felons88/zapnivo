import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { SessionUser } from "@/lib/auth";
import { systemAudit, type SystemActor } from "./audit";
import { requireElevation } from "./elevation";
import { isUuid } from "./kiosks";

/**
 * Kiosk update release registry (migration 0067, table kiosk_update_releases).
 *
 * HONESTY RULES:
 *  - A release row is METADATA + approval state only. Artifact bytes live in
 *    the PRIVATE Supabase Storage bucket `kiosk-updates` (see UPDATE_BUCKET
 *    below) — this module never stores or serves executable content, and
 *    never returns public URLs. The bucket is NOT created by migrations; an
 *    operator must create it as private (`supabase storage` / dashboard) before
 *    artifacts can be uploaded. Until then storage_bucket/storage_path remain
 *    null and releases can still be drafted/approved as metadata-only records.
 *  - Firmware/software approvals REQUIRE signature_status='verified' (also
 *    enforced by the kiosk_update_releases_verified_chk DB constraint) AND a
 *    fresh step-up elevation (requireElevation — MFA within ~15 min). Config
 *    and display_manifest kinds are exempt from both gates.
 *  - Approved rows are IMMUTABLE (DB trigger): only status may move
 *    approved→deprecated|revoked. This module additionally refuses metadata
 *    edits on non-draft rows before touching the DB.
 *  - Status machine mirrors the trigger: draft→approved|revoked,
 *    approved→deprecated|revoked; deprecated/revoked are terminal.
 */

export const UPDATE_BUCKET = "kiosk-updates";
export const UPDATE_BUCKET_NOTE =
  "Artifacts must be uploaded to the PRIVATE Supabase Storage bucket 'kiosk-updates' " +
  "(create it private via `supabase storage` or the dashboard — it is intentionally " +
  "not provisioned by migrations). Never make it public; device ingest uses signed URLs.";

export const RELEASE_KINDS = ["firmware", "software", "config", "display_manifest"] as const;
export type ReleaseKind = (typeof RELEASE_KINDS)[number];
export const isReleaseKind = (v: unknown): v is ReleaseKind =>
  typeof v === "string" && (RELEASE_KINDS as readonly string[]).includes(v);

export const RELEASE_CHANNELS = ["canary", "beta", "stable"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

export const SIGNATURE_STATUSES = ["unsigned", "signed", "verified", "rejected"] as const;
export type SignatureStatus = (typeof SIGNATURE_STATUSES)[number];

export const RELEASE_STATUSES = ["draft", "approved", "deprecated", "revoked"] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

/** Kinds that ship executable artifacts — approval requires verified signature + MFA elevation. */
export const EXECUTABLE_KINDS: readonly ReleaseKind[] = ["firmware", "software"];
export const isExecutableKind = (k: ReleaseKind) => EXECUTABLE_KINDS.includes(k);

/** Allowed lifecycle edges (mirrors the DB immutability trigger). */
export const RELEASE_TRANSITIONS: Record<ReleaseStatus, readonly ReleaseStatus[]> = {
  draft: ["approved", "revoked"],
  approved: ["deprecated", "revoked"],
  deprecated: [],
  revoked: [],
};

export const RELEASE_SELECT =
  "id,kind,version,channel,manufacturer,model,hw_revision_min,storage_bucket,storage_path,sha256,signature_status,signature_key_id,release_notes,status,uploaded_by,approved_by,approved_at,created_at,updated_at";

export type KioskUpdateRelease = {
  id: string;
  kind: ReleaseKind;
  version: string;
  channel: ReleaseChannel;
  manufacturer: string | null;
  model: string | null;
  hw_revision_min: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  sha256: string | null;
  signature_status: SignatureStatus;
  signature_key_id: string | null;
  release_notes: string | null;
  status: ReleaseStatus;
  uploaded_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

export const releaseAuditResource = (id: string) => `kiosk_update_release:${id}`;

const SHA256_RE = /^[0-9a-f]{64}$/;
const isSha256 = (v: string) => SHA256_RE.test(v);

/* ── Schemas ──────────────────────────────────────────────────────────────── */

const optText = (max: number) => z.string().trim().max(max).optional();

/** Fields settable at draft creation (all DB columns except server-managed ones). */
export const createReleaseSchema = z.object({
  kind: z.enum(RELEASE_KINDS),
  version: z.string().trim().min(1).max(120),
  channel: z.enum(RELEASE_CHANNELS).default("stable"),
  manufacturer: optText(120),
  model: optText(120),
  hw_revision_min: optText(60),
  storage_bucket: optText(120),
  storage_path: optText(500),
  sha256: z.string().trim().regex(SHA256_RE, "sha256 must be 64 lowercase hex chars").optional(),
  signature_status: z.enum(SIGNATURE_STATUSES).default("unsigned"),
  signature_key_id: optText(200),
  release_notes: z.string().trim().max(8000).optional(),
}).strict();
export type CreateReleaseInput = z.infer<typeof createReleaseSchema>;

/** Editable fields on a DRAFT release (metadata + artifact coordinates). */
export const releaseMetadataSchema = z.object({
  version: z.string().trim().min(1).max(120).optional(),
  channel: z.enum(RELEASE_CHANNELS).optional(),
  manufacturer: optText(120),
  model: optText(120),
  hw_revision_min: optText(60),
  storage_bucket: optText(120),
  storage_path: optText(500),
  sha256: z.string().trim().regex(SHA256_RE, "sha256 must be 64 lowercase hex chars").optional(),
  signature_status: z.enum(SIGNATURE_STATUSES).optional(),
  signature_key_id: optText(200),
  release_notes: z.string().trim().max(8000).optional(),
}).strict();
export type ReleaseMetadataInput = z.infer<typeof releaseMetadataSchema>;

export type ReleaseFailure = {
  ok: false;
  status: number;
  error: string;
  code?: string;
  issues?: z.core.$ZodIssue[];
};
export type ReleaseResult<T> = ({ ok: true } & T) | ReleaseFailure;

/* ── Reads ────────────────────────────────────────────────────────────────── */

export async function listReleases(
  db: SupabaseClient,
  filters: { kind?: string; status?: string; channel?: string; limit?: number } = {},
): Promise<{ releases: KioskUpdateRelease[]; error?: string }> {
  let q = db
    .from("kiosk_update_releases")
    .select(RELEASE_SELECT)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(filters.limit ?? 200, 1), 500));
  if (filters.kind && isReleaseKind(filters.kind)) q = q.eq("kind", filters.kind);
  if (filters.status && (RELEASE_STATUSES as readonly string[]).includes(filters.status)) {
    q = q.eq("status", filters.status);
  }
  if (filters.channel && (RELEASE_CHANNELS as readonly string[]).includes(filters.channel)) {
    q = q.eq("channel", filters.channel);
  }
  const { data, error } = await q;
  if (error) return { releases: [], error: error.message };
  return { releases: (data ?? []) as KioskUpdateRelease[] };
}

export async function getRelease(db: SupabaseClient, id: string): Promise<KioskUpdateRelease | null> {
  if (!isUuid(id)) return null;
  const { data, error } = await db.from("kiosk_update_releases").select(RELEASE_SELECT).eq("id", id).maybeSingle();
  if (error || !data) return null;
  return data as KioskUpdateRelease;
}

/* ── Draft creation ───────────────────────────────────────────────────────── */

/**
 * Inserts a draft release row (status='draft', uploaded_by=actor). Honest
 * failures: schema issues → 400, unique (kind,version,channel,manufacturer,
 * model) conflict → 409, DB error → 500. Audited as update.release.created.
 */
export async function createReleaseDraft(
  db: SupabaseClient,
  actor: SystemActor,
  rawInput: unknown,
): Promise<ReleaseResult<{ release: KioskUpdateRelease }>> {
  const parsed = createReleaseSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid release", issues: parsed.error.issues };
  }
  const input = parsed.data;
  const { data, error } = await db.from("kiosk_update_releases").insert({
    kind: input.kind,
    version: input.version,
    channel: input.channel,
    manufacturer: input.manufacturer ?? null,
    model: input.model ?? null,
    hw_revision_min: input.hw_revision_min ?? null,
    storage_bucket: input.storage_bucket ?? null,
    storage_path: input.storage_path ?? null,
    sha256: input.sha256 ?? null,
    signature_status: input.signature_status,
    signature_key_id: input.signature_key_id ?? null,
    release_notes: input.release_notes ?? null,
    status: "draft",
    uploaded_by: actor.id,
  }).select(RELEASE_SELECT).single();
  if (error || !data) {
    if (error?.code === "23505") {
      return { ok: false, status: 409, error: "A release with this kind/version/channel/model already exists" };
    }
    return { ok: false, status: 500, error: error?.message ?? "insert failed" };
  }
  const release = data as KioskUpdateRelease;
  await systemAudit(db, {
    actor, action: "update.release.created", resource: releaseAuditResource(release.id),
    detail: { kind: release.kind, version: release.version, channel: release.channel, signature_status: release.signature_status },
  });
  return { ok: true, release };
}

/* ── Draft metadata / artifact registration ───────────────────────────────── */

/**
 * Patches editable fields on a DRAFT release only. Once a release leaves
 * 'draft' its artifact coordinates are frozen (DB trigger) — this refuses
 * early with a clean 409 instead of surfacing a trigger exception.
 */
export async function updateReleaseMetadata(
  db: SupabaseClient,
  actor: SystemActor,
  id: string,
  rawInput: unknown,
): Promise<ReleaseResult<{ release: KioskUpdateRelease }>> {
  if (!isUuid(id)) return { ok: false, status: 404, error: "Release not found" };
  const parsed = releaseMetadataSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid metadata", issues: parsed.error.issues };
  }
  const existing = await getRelease(db, id);
  if (!existing) return { ok: false, status: 404, error: "Release not found" };
  if (existing.status !== "draft") {
    return { ok: false, status: 409, error: `Release is ${existing.status} — only draft releases are editable` };
  }
  const d = parsed.data;
  const patch: Record<string, unknown> = {};
  for (const key of [
    "version", "channel", "manufacturer", "model", "hw_revision_min",
    "storage_bucket", "storage_path", "sha256", "signature_status",
    "signature_key_id", "release_notes",
  ] as const) {
    if (d[key] !== undefined) patch[key] = d[key];
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, status: 400, error: "No editable fields supplied" };
  }
  const { data, error } = await db.from("kiosk_update_releases")
    .update(patch).eq("id", id).select(RELEASE_SELECT).single();
  if (error || !data) {
    if (error?.code === "23505") {
      return { ok: false, status: 409, error: "A release with this kind/version/channel/model already exists" };
    }
    return { ok: false, status: 500, error: error?.message ?? "update failed" };
  }
  const release = data as KioskUpdateRelease;
  await systemAudit(db, {
    actor, action: "update.release.metadata_updated", resource: releaseAuditResource(release.id),
    detail: { kind: release.kind, version: release.version, changed: Object.keys(patch) },
  });
  return { ok: true, release };
}

/**
 * Registers artifact coordinates for a draft release. Storage MUST point at
 * the private `kiosk-updates` bucket (defaults storage_bucket to it); sha256
 * is format-checked (64 lowercase hex) — callers that upload bytes should
 * compute it server-side from the actual content. This function stores
 * METADATA ONLY: it never uploads bytes and never returns public URLs.
 */
export async function registerArtifactMetadata(
  db: SupabaseClient,
  actor: SystemActor,
  id: string,
  artifact: {
    storage_path: string;
    sha256: string;
    storage_bucket?: string;
    signature_status?: SignatureStatus;
    signature_key_id?: string;
  },
): Promise<ReleaseResult<{ release: KioskUpdateRelease }>> {
  if (!artifact.storage_path?.trim()) {
    return { ok: false, status: 400, error: "storage_path is required" };
  }
  if (!isSha256(artifact.sha256 ?? "")) {
    return { ok: false, status: 400, error: "sha256 must be 64 lowercase hex chars" };
  }
  return updateReleaseMetadata(db, actor, id, {
    storage_bucket: artifact.storage_bucket?.trim() || UPDATE_BUCKET,
    storage_path: artifact.storage_path.trim(),
    sha256: artifact.sha256,
    signature_status: artifact.signature_status,
    signature_key_id: artifact.signature_key_id,
  });
}

/* ── Status transitions ───────────────────────────────────────────────────── */

async function transitionRelease(
  db: SupabaseClient,
  actor: SystemActor,
  id: string,
  to: ReleaseStatus,
  auditAction: string,
): Promise<ReleaseResult<{ release: KioskUpdateRelease }>> {
  if (!isUuid(id)) return { ok: false, status: 404, error: "Release not found" };
  const existing = await getRelease(db, id);
  if (!existing) return { ok: false, status: 404, error: "Release not found" };
  const from = existing.status;
  if (from === to) return { ok: false, status: 409, error: `Release is already ${to}` };
  if (!RELEASE_TRANSITIONS[from].includes(to)) {
    return { ok: false, status: 409, error: `Illegal transition ${from} → ${to}` };
  }
  const patch: Record<string, unknown> = { status: to };
  if (to === "approved") {
    patch.approved_by = actor.id;
    patch.approved_at = new Date().toISOString();
  }
  const { data, error } = await db.from("kiosk_update_releases")
    .update(patch).eq("id", id).select(RELEASE_SELECT).single();
  if (error || !data) {
    // 23514 = check_violation (e.g. approved firmware without verified signature)
    if (error?.code === "23514") {
      return { ok: false, status: 409, error: "Database rejected the transition (check constraint)" };
    }
    return { ok: false, status: 500, error: error?.message ?? "update failed" };
  }
  const release = data as KioskUpdateRelease;
  await systemAudit(db, {
    actor, action: auditAction, resource: releaseAuditResource(release.id),
    detail: { from, to, kind: release.kind, version: release.version, channel: release.channel },
  });
  return { ok: true, release };
}

/**
 * Approves a draft release. Executable kinds (firmware/software) require:
 *  1. signature_status='verified' — unsigned/signed/rejected → 409 (the DB
 *     check constraint enforces the same rule; we fail first with a clean error).
 *  2. A live step-up elevation (requireElevation — fresh MFA, ≤15 min). Missing
 *     → 403 with code 'step_up_required'.
 * Config/display_manifest approvals need neither. Audited as
 * update.release.approved.
 */
export async function approveRelease(
  db: SupabaseClient,
  actor: SystemActor,
  id: string,
  user: SessionUser | null,
): Promise<ReleaseResult<{ release: KioskUpdateRelease }>> {
  if (!isUuid(id)) return { ok: false, status: 404, error: "Release not found" };
  const existing = await getRelease(db, id);
  if (!existing) return { ok: false, status: 404, error: "Release not found" };
  if (existing.status !== "draft") {
    return { ok: false, status: 409, error: `Only draft releases can be approved (current: ${existing.status})` };
  }
  if (isExecutableKind(existing.kind)) {
    if (existing.signature_status !== "verified") {
      return {
        ok: false, status: 409,
        error: `${existing.kind} releases require signature_status='verified' before approval (current: '${existing.signature_status}')`,
      };
    }
    const elev = await requireElevation(db, user);
    if (!elev.ok) {
      return { ok: false, status: elev.status, error: elev.error, code: elev.code };
    }
  }
  return transitionRelease(db, actor, id, "approved", "update.release.approved");
}

/** approved → deprecated. Terminal for rollout purposes; audited. */
export async function deprecateRelease(
  db: SupabaseClient,
  actor: SystemActor,
  id: string,
): Promise<ReleaseResult<{ release: KioskUpdateRelease }>> {
  return transitionRelease(db, actor, id, "deprecated", "update.release.deprecated");
}

/** draft|approved → revoked. Terminal; audited. */
export async function revokeRelease(
  db: SupabaseClient,
  actor: SystemActor,
  id: string,
): Promise<ReleaseResult<{ release: KioskUpdateRelease }>> {
  return transitionRelease(db, actor, id, "revoked", "update.release.revoked");
}
