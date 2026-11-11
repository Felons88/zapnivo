import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assignVariant, AUDIENCE_RE, canTransition, EXPERIMENT_KEY_RE, isActive, isForbiddenAudience, VARIANT_KEY_RE,
  type Experiment, type ExperimentStatus, type ExperimentVariant, type ExperimentWithVariants,
} from "./core";

/**
 * Experiments service — all DB access for the A/B framework. Pure logic lives in
 * core.ts; this file owns reads/writes. Never throws on missing data (returns
 * null / ok:false) so API routes can answer honestly.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** profiles.id / approved_by must be a real uuid — dev-store synthetic ids become null. */
const uuidOrNull = (id: string | null | undefined) => (id && UUID_RE.test(id) ? id : null);

type Row = Record<string, unknown>;
type Db = SupabaseClient;

function toVariant(r: Row): ExperimentVariant {
  return {
    id: typeof r.id === "string" ? r.id : undefined,
    key: String(r.key ?? ""),
    weight: Number(r.weight ?? 0),
    config: (r.config && typeof r.config === "object" && !Array.isArray(r.config) ? r.config : {}) as Record<string, unknown>,
  };
}

function toExperiment(r: Row, variants: Row[] = []): ExperimentWithVariants {
  return {
    id: String(r.id),
    key: String(r.key),
    name: String(r.name ?? ""),
    hypothesis: typeof r.hypothesis === "string" ? r.hypothesis : null,
    status: String(r.status) as ExperimentStatus,
    audience: String(r.audience ?? "public"),
    start_at: typeof r.start_at === "string" ? r.start_at : null,
    end_at: typeof r.end_at === "string" ? r.end_at : null,
    guardrail_metrics: Array.isArray(r.guardrail_metrics) ? (r.guardrail_metrics as string[]) : [],
    variants: variants.map(toVariant),
  };
}

const normVariants = (rows: Row[] | null | undefined): ExperimentVariant[] =>
  (rows ?? []).map(toVariant).sort((a, b) => a.key.localeCompare(b.key));

/** All experiments with their variants (staff view — includes drafts). */
export async function listExperiments(db: Db): Promise<ExperimentWithVariants[]> {
  const { data, error } = await db.from("experiments").select("*, experiment_variants(*)").order("created_at", { ascending: false }).limit(200);
  if (error || !data) return [];
  return (data as Row[]).map((r) => toExperiment(r, (r.experiment_variants as Row[] | null) ?? []));
}

async function fetchOne(db: Db, filter: "key" | "id", value: string): Promise<ExperimentWithVariants | null> {
  const q = db.from("experiments").select("*, experiment_variants(*)");
  const { data, error } = await (filter === "key" ? q.eq("key", value) : q.eq("id", value)).maybeSingle();
  if (error || !data) return null;
  const r = data as Row;
  return toExperiment(r, (r.experiment_variants as Row[] | null) ?? []);
}

/** Lookup by experiment key (preferred) or uuid id. */
export async function getExperiment(db: Db, keyOrId: string): Promise<ExperimentWithVariants | null> {
  const byKey = await fetchOne(db, "key", keyOrId);
  if (byKey) return byKey;
  return UUID_RE.test(keyOrId) ? fetchOne(db, "id", keyOrId) : null;
}

export type CreateInput = {
  key: string;
  name: string;
  hypothesis?: string | null;
  audience?: string;
  guardrail_metrics?: string[];
  start_at?: string | null;
  end_at?: string | null;
  variants: { key: string; config?: Record<string, unknown>; weight: number }[];
  created_by?: string | null;
};

export type ServiceResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

const parseWhen = (v: string | null | undefined): string | null | undefined => {
  if (v === undefined || v === null || v === "") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

/** Creates an experiment in 'draft' status with its variants. Validates shape here; the DB re-checks audience. */
export async function createExperiment(db: Db, input: CreateInput): Promise<ServiceResult<{ id: string }>> {
  const key = input.key?.trim() ?? "";
  const name = input.name?.trim() ?? "";
  const audience = (input.audience ?? "public").trim() || "public";
  if (!EXPERIMENT_KEY_RE.test(key)) return { ok: false, error: "Key must be 1-63 chars: lowercase letters, numbers, - or _." };
  if (!name) return { ok: false, error: "Name is required." };
  if (!AUDIENCE_RE.test(audience) || isForbiddenAudience(audience)) return { ok: false, error: "Audience is not allowed for experiments." };

  const variants = (input.variants ?? []).filter((v) => v && typeof v.key === "string");
  if (variants.length < 2) return { ok: false, error: "At least two variants are required." };
  const seen = new Set<string>();
  for (const v of variants) {
    const vk = v.key.trim();
    if (!VARIANT_KEY_RE.test(vk)) return { ok: false, error: `Invalid variant key "${v.key}".` };
    if (seen.has(vk)) return { ok: false, error: `Duplicate variant key "${vk}".` };
    seen.add(vk);
    if (!Number.isInteger(v.weight) || v.weight <= 0) return { ok: false, error: `Variant "${vk}" needs a positive integer weight.` };
    if (v.config !== undefined && (typeof v.config !== "object" || v.config === null || Array.isArray(v.config))) {
      return { ok: false, error: `Variant "${vk}" config must be a JSON object.` };
    }
  }

  const startAt = parseWhen(input.start_at);
  const endAt = parseWhen(input.end_at);
  if (startAt === undefined || endAt === undefined) return { ok: false, error: "Invalid start/end date." };
  if (startAt && endAt && Date.parse(endAt) <= Date.parse(startAt)) return { ok: false, error: "End must be after start." };

  const guardrails = (input.guardrail_metrics ?? []).map((g) => String(g).trim()).filter(Boolean).slice(0, 20);

  const { data: exp, error } = await db.from("experiments").insert({
    key, name, hypothesis: input.hypothesis?.trim() || null, status: "draft", audience,
    start_at: startAt ?? null, end_at: endAt ?? null, guardrail_metrics: guardrails,
    created_by: uuidOrNull(input.created_by ?? null),
  }).select("id").single();
  if (error || !exp) return { ok: false, error: error?.message ?? "Could not create experiment." };
  const id = String((exp as Row).id);

  const { error: vErr } = await db.from("experiment_variants").insert(
    variants.map((v) => ({ experiment_id: id, key: v.key.trim(), config: v.config ?? {}, weight: v.weight })),
  );
  if (vErr) {
    await db.from("experiments").delete().eq("id", id); // don't leave a variant-less draft
    return { ok: false, error: vErr.message };
  }
  return { ok: true, data: { id } };
}

/**
 * State-machine transition. draft→approved records the approver (human gate);
 * →running additionally requires a sane window (end after start when both set).
 */
export async function transition(db: Db, id: string, to: ExperimentStatus, staffId: string | null): Promise<ServiceResult> {
  const exp = UUID_RE.test(id) ? await fetchOne(db, "id", id) : await getExperiment(db, id);
  if (!exp) return { ok: false, error: "Experiment not found." };
  if (!canTransition(exp.status, to)) return { ok: false, error: `Cannot move ${exp.status} → ${to}.` };
  if (!staffId) return { ok: false, error: "A staff actor is required." };

  const patch: Row = { status: to };
  if (to === "approved") patch.approved_by = uuidOrNull(staffId); // human approval gate
  if (to === "running" && exp.start_at && exp.end_at && Date.parse(exp.end_at) <= Date.parse(exp.start_at)) {
    return { ok: false, error: "End must be after start before running." };
  }
  const { error } = await db.from("experiments").update(patch).eq("id", exp.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** subject_hash column is text — store the 32-bit hash as fixed-width hex. */
export const subjectHashText = (subjectHash: number) => (subjectHash >>> 0).toString(16).padStart(8, "0");

export type Assignment = { experiment_id: string; experiment_key: string; variant_key: string; config: Record<string, unknown> };

/**
 * Assigns a subject to a variant for an ACTIVE experiment only. Upserts the
 * assignment (first write wins on conflict), then returns the stored row so the
 * API always reflects what was actually recorded.
 */
export async function assign(db: Db, key: string, subjectHash: number): Promise<Assignment | null> {
  const exp = await fetchOne(db, "key", key);
  if (!exp || !isActive(exp)) return null;

  const subject = subjectHashText(subjectHash);
  const pick = assignVariant(exp.variants, subjectHash);
  if (!pick) return null;

  await db.from("experiment_assignments").upsert(
    { experiment_id: exp.id, subject_hash: subject, variant_key: pick },
    { onConflict: "experiment_id,subject_hash", ignoreDuplicates: true },
  );

  const { data } = await db.from("experiment_assignments")
    .select("variant_key").eq("experiment_id", exp.id).eq("subject_hash", subject).maybeSingle();
  const variantKey = String((data as Row | null)?.variant_key ?? pick);
  const variant = exp.variants.find((v) => v.key === variantKey);
  return { experiment_id: exp.id, experiment_key: exp.key, variant_key: variantKey, config: variant?.config ?? {} };
}

/** Marks first exposure for an assignment. Idempotent — only sets exposed_at when null. */
export async function recordExposure(db: Db, experimentId: string, subjectHash: number): Promise<void> {
  await db.from("experiment_assignments")
    .update({ exposed_at: new Date().toISOString() })
    .eq("experiment_id", experimentId).eq("subject_hash", subjectHashText(subjectHash)).is("exposed_at", null);
}

/**
 * Marks first conversion. `metric` is accepted for forward compatibility —
 * assignments currently have a single converted_at regardless of metric.
 */
export async function recordConversion(db: Db, experimentId: string, subjectHash: number, _metric?: string): Promise<void> {
  await db.from("experiment_assignments")
    .update({ converted_at: new Date().toISOString() })
    .eq("experiment_id", experimentId).eq("subject_hash", subjectHashText(subjectHash)).is("converted_at", null);
}

export type VariantResult = {
  variant_key: string;
  assigned: number;
  exposed: number;
  converted: number;
  /** converted / exposed; null when nothing has been exposed yet (no fabricated rates). */
  conversion_rate: number | null;
};

/** Real per-variant counts for one experiment. */
export async function results(db: Db, experimentId: string): Promise<VariantResult[]> {
  const exp = await fetchOne(db, "id", experimentId);
  if (!exp) return [];
  const { data } = await db.from("experiment_assignments")
    .select("variant_key, exposed_at, converted_at").eq("experiment_id", experimentId).limit(10000);
  const rows = (data ?? []) as Row[];

  return exp.variants.map((v) => {
    const mine = rows.filter((r) => r.variant_key === v.key);
    const exposed = mine.filter((r) => r.exposed_at).length;
    const converted = mine.filter((r) => r.converted_at).length;
    return {
      variant_key: v.key,
      assigned: mine.length,
      exposed,
      converted,
      conversion_rate: exposed > 0 ? converted / exposed : null,
    };
  });
}
