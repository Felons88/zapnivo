/**
 * Experiments core — pure, deterministic, unit-testable. No db imports here;
 * the service layer (service.ts) owns persistence.
 *
 * Bucketing is FNV-1a based (same family as src/lib/observability.ts) so a given
 * subject + experiment always lands on the same variant — assignments are sticky
 * by construction, and the DB upsert is only a record of that decision.
 */

export type ExperimentStatus = "draft" | "approved" | "running" | "paused" | "concluded";
export const EXPERIMENT_STATUSES: readonly ExperimentStatus[] = ["draft", "approved", "running", "paused", "concluded"];

export type Experiment = {
  id: string;
  key: string;
  name: string;
  hypothesis: string | null;
  status: ExperimentStatus;
  audience: string;
  start_at: string | null;
  end_at: string | null;
  guardrail_metrics: string[];
};

export type ExperimentVariant = {
  id?: string;
  key: string;
  weight: number;
  config: Record<string, unknown>;
};

export type ExperimentWithVariants = Experiment & { variants: ExperimentVariant[] };

/** Audiences that may never be experimented on — enforced here AND by a DB check. */
export const FORBIDDEN_AUDIENCES = ["security", "consent", "pricing_disclosure"] as const;
export const isForbiddenAudience = (a: string) => (FORBIDDEN_AUDIENCES as readonly string[]).includes(a);

export const EXPERIMENT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const VARIANT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const AUDIENCE_RE = /^[a-z][a-z0-9_]{0,40}$/;

/** Stable non-cryptographic 32-bit hash (FNV-1a) — edge-runtime safe, no node:crypto. */
export function hashSubject(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic weighted pick: hash mod total weight → cumulative buckets.
 * Same subjectHash + same variant list always returns the same key.
 * Returns null when there is nothing assignable.
 */
export function assignVariant(variants: { key: string; weight: number }[], subjectHash: number): string | null {
  const usable = variants.filter((v) => Number.isFinite(v.weight) && v.weight > 0);
  const total = usable.reduce((s, v) => s + v.weight, 0);
  if (usable.length === 0 || total <= 0) return null;
  let bucket = ((subjectHash % total) + total) % total;
  for (const v of usable) {
    if (bucket < v.weight) return v.key;
    bucket -= v.weight;
  }
  return usable[usable.length - 1].key;
}

/** Running AND inside the optional [start_at, end_at] window (inclusive). */
export function isActive(exp: Pick<Experiment, "status" | "start_at" | "end_at">, now: Date | number = Date.now()): boolean {
  if (exp.status !== "running") return false;
  const t = typeof now === "number" ? now : now.getTime();
  if (exp.start_at) {
    const s = Date.parse(exp.start_at);
    if (Number.isFinite(s) && s > t) return false;
  }
  if (exp.end_at) {
    const e = Date.parse(exp.end_at);
    if (Number.isFinite(e) && e < t) return false;
  }
  return true;
}

/**
 * The state machine. Drafts must be human-approved before they can run —
 * draft→running is deliberately absent.
 */
export const TRANSITIONS: Record<ExperimentStatus, readonly ExperimentStatus[]> = {
  draft: ["approved"],
  approved: ["running"],
  running: ["paused", "concluded"],
  paused: ["running", "concluded"],
  concluded: [],
};

export const canTransition = (from: ExperimentStatus, to: ExperimentStatus) => TRANSITIONS[from].includes(to);

/** Suggested audiences for the admin picker — anything else matching AUDIENCE_RE is also accepted. */
export const AUDIENCE_OPTIONS = ["public", "customer", "partner", "internal"] as const;
