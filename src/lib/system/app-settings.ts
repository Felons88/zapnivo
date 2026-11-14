import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionUser } from "@/lib/auth";
import { systemAudit, type SystemActor } from "./audit";
import { requireElevation } from "./elevation";

/**
 * Nonsecret application settings (system_app_settings, migration 0065).
 *
 * WHITELISTED REGISTRY MODEL: APP_SETTING_REGISTRY below is the complete
 * allowlist of writable keys. setAppSetting rejects ANY key not in the
 * registry, any key that looks secret-ish, and any value that fails the
 * per-key validator or looks like secret material. There is no path to
 * arbitrary keys, arbitrary JSON, or credentials — this table can never
 * become a secret store.
 *
 * Honest semantics: a stored value is configuration DATA. Code paths that
 * need a setting read it via getAppSetting/listAppSettings; keys whose
 * runtime readers are not wired yet record intended state + audit trail
 * (same honesty contract as feature flags in flags.ts — see each key's
 * description for whether a live reader exists).
 *
 * Risk model:
 *  - risk 'low'  — any system.flags.manage principal may write (still audited
 *                  + change-request gated for breakglass via the route).
 *  - risk 'high' — additionally requires a FRESH step-up elevation
 *                  (requireElevation, ≤15 min old) enforced HERE in
 *                  setAppSetting, plus the route's assertApprovedOrRequest
 *                  with risk 'high' (approved change request for every role).
 *
 * environment is a single text column on a key-PK row: it records the
 * environment the last write targeted (same convention as
 * system_feature_flags). One row per key.
 */

export type AppSettingRisk = "low" | "high";
export type AppSettingKind = "boolean" | "string";

export type AppSettingDef = {
  key: string;
  risk: AppSettingRisk;
  kind: AppSettingKind;
  /** string kind only — max accepted length (chars). */
  maxLength?: number;
  default: unknown;
  description: string;
};

/**
 * The allowlist. Keys use dotted lowercase namespaces; values are booleans or
 * bounded plain strings ONLY — never objects, numbers, arrays, or secrets.
 */
export const APP_SETTING_REGISTRY: readonly AppSettingDef[] = [
  {
    key: "maintenance.notice_enabled",
    risk: "low",
    kind: "boolean",
    default: false,
    description: "Show the maintenance notice banner site-wide. Paired with maintenance.notice_text for the copy.",
  },
  {
    key: "maintenance.notice_text",
    risk: "low",
    kind: "string",
    maxLength: 300,
    default: "",
    description: "Maintenance notice banner text — plain text, ≤300 chars, rendered verbatim (escaped) when notice_enabled is true.",
  },
  {
    key: "site.maintenance_mode",
    risk: "high",
    kind: "boolean",
    default: false,
    description: "Site-wide maintenance mode flag. HIGH RISK: step-up elevation + approved change request required. Readers must gate public traffic on this value.",
  },
  {
    key: "support.public_hours",
    risk: "low",
    kind: "string",
    maxLength: 200,
    default: "",
    description: "Public support hours shown on the help center — free text, ≤200 chars (e.g. 'Mon–Fri 9am–6pm ET').",
  },
  {
    key: "newsletter.footer_text",
    risk: "low",
    kind: "string",
    maxLength: 500,
    default: "",
    description: "Footer line appended to newsletter emails — plain text, ≤500 chars.",
  },
  {
    key: "analytics.enabled",
    risk: "low",
    kind: "boolean",
    default: false,
    description: "Analytics collection toggle. NOTE: the analytics pipeline is additionally env-gated; this records intended state + audit.",
  },
  {
    key: "jobs.paused",
    risk: "high",
    kind: "string",
    maxLength: 500,
    default: "",
    description: "Comma-separated vercel.json cron job names paused by operators (Phase 4.4). HIGH RISK: step-up elevation required; cron routes check this each run and record a skipped cron_runs row. Financial/settlement jobs are denylisted in code and can never be paused.",
  },
];

const BY_KEY = new Map(APP_SETTING_REGISTRY.map((d) => [d.key, d]));
export const APP_SETTING_KEYS: readonly string[] = APP_SETTING_REGISTRY.map((d) => d.key);

/** Registry lookup — null for any non-whitelisted key. */
export function appSettingDef(key: string): AppSettingDef | null {
  return BY_KEY.get(key.trim()) ?? null;
}

/* ── Secret guards ────────────────────────────────────────────────────────── */

/** Keys that smell like secrets are refused even before the registry check. */
const SECRETISH_KEY = /secret|token|password|credential|private[_-]?key|api[_-]?key/i;
/** Values carrying recognizable secret material are refused. Mirrors the
 *  SECRETISH_VALUE pattern used for audit details (audit.ts). */
const SECRETISH_VALUE =
  /(sk-[a-z0-9_-]{6,}|whsec_[a-z0-9]+|SG\.[a-z0-9_.-]+|znk_[a-z0-9_-]+|znd_[a-z0-9_-]+)|(bearer\s+[a-z0-9._-]{6,})|(eyJ[A-Za-z0-9_-]{8,})|(?:api[_-]?key|secret|token|password|credential)\s*[:=]/i;

export type SettingValueCheck = { ok: true; value: unknown } | { ok: false; error: string };

/** Pure validator — unit tested. Only the def's declared kind is accepted. */
export function validateSettingValue(def: AppSettingDef, value: unknown): SettingValueCheck {
  if (def.kind === "boolean") {
    if (typeof value !== "boolean") return { ok: false, error: `${def.key} expects a boolean` };
    return { ok: true, value };
  }
  // kind === "string"
  if (typeof value !== "string") return { ok: false, error: `${def.key} expects a string` };
  const v = value.trim();
  const max = def.maxLength ?? 500;
  if (v.length > max) return { ok: false, error: `${def.key} exceeds ${max} characters` };
  if (SECRETISH_VALUE.test(v)) {
    return { ok: false, error: `${def.key} value looks like it contains secret material — app settings never store secrets` };
  }
  return { ok: true, value: v };
}

/* ── Read model ───────────────────────────────────────────────────────────── */

export type AppSettingView = {
  key: string;
  kind: AppSettingKind;
  risk: AppSettingRisk;
  description: string;
  /** Effective value: stored row value, or the registry default when unset. */
  value: unknown;
  /** True when no row exists — value is the registry default, not stored state. */
  isDefault: boolean;
  /** Environment recorded on the stored row (last-write target), or null. */
  environment: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  createdAt: string | null;
};

export type AppSettingsList = {
  configured: boolean;
  /** False when the table read failed (e.g. migration 0065 not applied) —
   *  settings then show registry defaults and the UI says so honestly. */
  storeAvailable: boolean;
  settings: AppSettingView[];
};

type SettingRow = {
  key: string;
  environment: string | null;
  value: unknown;
  risk: string | null;
  description: string | null;
  updated_by: string | null;
  updated_at: string | null;
  created_at: string | null;
};

const ROW_COLS = "key,environment,value,risk,description,updated_by,updated_at,created_at";

function viewFor(def: AppSettingDef, row: SettingRow | null): AppSettingView {
  return {
    key: def.key,
    kind: def.kind,
    risk: def.risk,
    description: row?.description || def.description,
    value: row ? row.value : def.default,
    isDefault: !row,
    environment: row?.environment ?? null,
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
    createdAt: row?.created_at ?? null,
  };
}

/** Lists every registry key merged with stored rows. Never throws. */
export async function listAppSettings(db: SupabaseClient | null | undefined): Promise<AppSettingsList> {
  const configured = Boolean(db);
  if (!db) {
    return { configured: false, storeAvailable: false, settings: APP_SETTING_REGISTRY.map((d) => viewFor(d, null)) };
  }
  try {
    const { data, error } = await db.from("system_app_settings").select(ROW_COLS).limit(200);
    if (error) {
      return { configured: true, storeAvailable: false, settings: APP_SETTING_REGISTRY.map((d) => viewFor(d, null)) };
    }
    const byKey = new Map<string, SettingRow>();
    for (const r of (data ?? []) as SettingRow[]) byKey.set(r.key, r);
    return {
      configured: true,
      storeAvailable: true,
      settings: APP_SETTING_REGISTRY.map((d) => viewFor(d, byKey.get(d.key) ?? null)),
    };
  } catch {
    return { configured: true, storeAvailable: false, settings: APP_SETTING_REGISTRY.map((d) => viewFor(d, null)) };
  }
}

export type GetAppSettingResult =
  | { ok: true; setting: AppSettingView }
  | { ok: false; status: number; error: string };

/** Reads one whitelisted setting (stored value or registry default). */
export async function getAppSetting(
  db: SupabaseClient | null | undefined,
  key: string,
): Promise<GetAppSettingResult> {
  const def = appSettingDef(key);
  if (!def) return { ok: false, status: 400, error: "Unknown setting key" };
  if (!db) return { ok: false, status: 503, error: "Backend not configured" };
  try {
    const { data, error } = await db
      .from("system_app_settings")
      .select(ROW_COLS)
      .eq("key", def.key)
      .maybeSingle();
    if (error) return { ok: false, status: 500, error: error.message ?? "read failed" };
    return { ok: true, setting: viewFor(def, (data as SettingRow | null) ?? null) };
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : "read failed" };
  }
}

/* ── Mutation ─────────────────────────────────────────────────────────────── */

export type SetAppSettingResult =
  | { ok: true; setting: AppSettingView }
  | { ok: false; status: number; error: string; code?: string };

/**
 * Writes one whitelisted setting. Validation order (fail closed, honest codes):
 *  1. db configured → 503
 *  2. secret-looking KEY → 400 (defense in depth; registry would reject anyway)
 *  3. key in registry → 400 unknown_setting
 *  4. value passes the per-key validator (kind/length/secret-scan) → 400
 *  5. risk 'high' → requireElevation (403 step_up_required without a fresh
 *     ≤15-minute elevation)
 *  6. upsert + system_audit_events row (app_setting.updated). The audit detail
 *     records metadata + the validated value — never key material, because
 *     secret-looking values were rejected in step 4.
 */
export async function setAppSetting(
  db: SupabaseClient | null | undefined,
  actor: SystemActor,
  user: SessionUser | null,
  input: { key: string; value: unknown; environment?: string },
): Promise<SetAppSettingResult> {
  if (!db) return { ok: false, status: 503, error: "Backend not configured" };
  const key = String(input.key ?? "").trim();
  if (!key) return { ok: false, status: 400, error: "key is required" };
  if (SECRETISH_KEY.test(key)) {
    return { ok: false, status: 400, error: "key looks secret-like — app settings never store secrets" };
  }
  const def = appSettingDef(key);
  if (!def) {
    return { ok: false, status: 400, error: `Unknown setting key '${key.slice(0, 80)}' — only whitelisted app settings may be written` };
  }
  const checked = validateSettingValue(def, input.value);
  if (!checked.ok) return { ok: false, status: 400, error: checked.error };

  if (def.risk === "high") {
    const elev = await requireElevation(db, user);
    if (!elev.ok) {
      return { ok: false, status: elev.status, error: elev.error, code: elev.code };
    }
  }

  const environment = (input.environment ?? "production").trim().slice(0, 40) || "production";
  const { data, error } = await db
    .from("system_app_settings")
    .upsert(
      {
        key: def.key,
        environment,
        value: checked.value,
        risk: def.risk,
        description: def.description,
        updated_by: actor.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    )
    .select(ROW_COLS)
    .single();
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "setting update failed" };

  await systemAudit(db, {
    actor,
    action: "app_setting.updated",
    resource: `app_setting:${def.key}`,
    detail: { setting: def.key, environment, risk: def.risk, value: checked.value },
  });
  return { ok: true, setting: viewFor(def, data as SettingRow) };
}
