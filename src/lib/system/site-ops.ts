import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionUser } from "@/lib/auth";
import { systemAudit, assertApprovedOrRequest, type ChangeRisk, type SystemActor } from "./audit";
import { SITE_KEYS, SITE_REGISTRY, isSiteKey } from "./site-cms";

/**
 * Website ops controls for system.zapnivo.com — maintenance notices and
 * DB-driven redirect rules.
 *
 * Maintenance notices reuse the emergency 'maintenance_banner' op
 * (src/lib/system/emergency.ts) via executeEmergencyOp — one write path, one
 * audit contract, same elevation + change-request gates. This module only
 * READS notice state for the admin UI and owns redirect CRUD.
 *
 * Redirect rules (site_redirects, migration 0062):
 *  - to_path may be a RELATIVE path ('/new-place') or a SAME-HOST https URL on
 *    an approved Zapnivo host (apex, *.zapnivo.com, localhost/*.localhost in
 *    dev). Arbitrary external redirects are rejected — open-redirect hardening.
 *  - Every mutation writes a system_audit_events row and passes through
 *    assertApprovedOrRequest (risk 'medium' — breakglass always needs an
 *    approved change request; requester ≠ approver enforced there).
 */

/* ── Redirect validation (pure — unit tested) ───────────────────────────── */

const FROM_PATH_RE = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#[\]]*$/;
const MAX_PATH = 500;

/** Hosts a redirect target may point at (same-host only — never arbitrary external). */
const ALLOWED_TARGET_HOSTS = new Set([
  "zapnivo.com",
  "www.zapnivo.com",
  "localhost",
]);
const ALLOWED_TARGET_SUFFIXES = [".zapnivo.com", ".localhost"];

export function isAllowedRedirectHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (ALLOWED_TARGET_HOSTS.has(h)) return true;
  return ALLOWED_TARGET_SUFFIXES.some((s) => h.endsWith(s));
}

export type PathCheck = { ok: true; value: string } | { ok: false; error: string };

/** from_path: a site-relative path. Must start with exactly one '/', no scheme, no '..'.
 *  '%' is rejected: the runtime normalizes by percent-decoding, so the canonical
 *  stored form is the DECODED path (e.g. store the literal path, never %20).
 *  This keeps write-side and read-side normalization identical. */
export function validateFromPath(input: unknown): PathCheck {
  const v = typeof input === "string" ? input.trim() : "";
  if (!v || v.length > MAX_PATH) return { ok: false, error: "from_path is required (≤500 chars)" };
  if (!v.startsWith("/") || v.startsWith("//")) return { ok: false, error: "from_path must start with a single '/'" };
  if (/\s/.test(v) || v.includes("://") || v.includes("..") || v.includes("%") || v.includes("\\")) {
    return { ok: false, error: "from_path must be a clean decoded relative path (no whitespace, scheme, '..', '%', or '\\')" };
  }
  if (!FROM_PATH_RE.test(v)) return { ok: false, error: "from_path contains disallowed characters" };
  return { ok: true, value: v };
}

/**
 * to_path: EITHER a relative path (same rules as from_path) OR an absolute
 * https URL on an approved Zapnivo host. http: is tolerated ONLY for
 * localhost/*.localhost (dev mirrors prod). Everything else is rejected.
 */
export function validateToPath(input: unknown): PathCheck {
  const v = typeof input === "string" ? input.trim() : "";
  if (!v || v.length > 2000) return { ok: false, error: "to_path is required (≤2000 chars)" };
  // Protocol-relative / backslash-leading forms are never valid targets.
  if (v.startsWith("\\") || v.startsWith("/\\")) {
    return { ok: false, error: "to_path must be a relative path or an absolute https URL" };
  }
  if (v.startsWith("/")) {
    const rel = validateFromPath(v);
    if (!rel.ok) return rel;
    return { ok: true, value: rel.value };
  }
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return { ok: false, error: "to_path must be a relative path or an absolute https URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "to_path must use https:// (http only allowed for localhost dev hosts)" };
  }
  const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  if (url.protocol === "http:" && !local) {
    return { ok: false, error: "to_path must use https:// (http only allowed for localhost dev hosts)" };
  }
  if (url.username || url.password) {
    return { ok: false, error: "to_path must not contain credentials" };
  }
  if (!isAllowedRedirectHost(url.hostname)) {
    return { ok: false, error: `to_path host '${url.hostname}' is not an approved Zapnivo host — arbitrary external redirects are not allowed` };
  }
  return { ok: true, value: url.toString() };
}

/* ── Row shape + listing ────────────────────────────────────────────────── */

export type SiteRedirectRow = {
  id: string;
  site_key: string;
  from_path: string;
  to_path: string;
  enabled: boolean;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

const REDIRECT_COLS = "id,site_key,from_path,to_path,enabled,note,created_by,created_at,updated_at";

export async function listRedirects(db: SupabaseClient | null, siteKey?: string): Promise<SiteRedirectRow[]> {
  if (!db) return [];
  let q = db.from("site_redirects").select(REDIRECT_COLS).order("site_key").order("from_path").limit(1000);
  if (siteKey) q = q.eq("site_key", siteKey);
  const { data, error } = await q;
  if (error) return [];
  return (data ?? []) as unknown as SiteRedirectRow[];
}

export type SiteOpsSummary = {
  configured: boolean;
  sites: { key: string; label: string; host: string; classification: string; redirects: number; redirectsEnabled: number }[];
  redirectTotal: number;
};

/** Per-site operational status for the ops page — counts only, no fabricated health. */
export async function siteOpsSummary(db: SupabaseClient | null): Promise<SiteOpsSummary> {
  const redirects = await listRedirects(db);
  const bySite = new Map<string, { total: number; enabled: number }>();
  for (const r of redirects) {
    const cur = bySite.get(r.site_key) ?? { total: 0, enabled: 0 };
    cur.total += 1;
    if (r.enabled) cur.enabled += 1;
    bySite.set(r.site_key, cur);
  }
  const sites = SITE_REGISTRY.map((s) => ({
    key: s.key,
    label: s.label,
    host: s.host,
    classification: s.classification,
    redirects: bySite.get(s.key)?.total ?? 0,
    redirectsEnabled: bySite.get(s.key)?.enabled ?? 0,
  }));
  return { configured: Boolean(db), sites, redirectTotal: redirects.length };
}

/* ── Mutations ──────────────────────────────────────────────────────────── */

export type SiteOpsResult =
  | { ok: true; id?: string; summary: string }
  | { ok: false; status: number; error: string; pending?: boolean; changeRequestId?: string };

const fail = (status: number, error: string, extra: Partial<Extract<SiteOpsResult, { ok: false }>> = {}): SiteOpsResult =>
  ({ ok: false, status, error, ...extra }) as SiteOpsResult;

/** Change-request risk per mutation — 'medium' never auto-requires approval, but breakglass always does. */
const riskFor = (kind: "create" | "update" | "delete" | "toggle"): ChangeRisk =>
  kind === "toggle" ? "low" : "medium";

async function gate(
  db: SupabaseClient,
  actor: SystemActor,
  action: string,
  justification: string,
  risk: ChangeRisk,
): Promise<{ ok: true; changeRequestId: string | null } | { ok: false; res: SiteOpsResult }> {
  const approval = await assertApprovedOrRequest(db, actor, { action, risk, justification });
  if (approval.status === "pending") {
    return { ok: false, res: fail(202, "Change request created — awaiting approval", { pending: true, changeRequestId: approval.changeRequestId }) };
  }
  if (approval.status === "rejected") return { ok: false, res: fail(409, "Change request was rejected") };
  if (approval.status === "error") return { ok: false, res: fail(500, approval.error) };
  return { ok: true, changeRequestId: approval.changeRequestId };
}

const audit = (db: SupabaseClient, actor: SystemActor, action: string, resource: string, detail: Record<string, unknown>) =>
  systemAudit(db, { actor, action, resource, detail });

export type RedirectInput = {
  site_key?: unknown;
  from_path?: unknown;
  to_path?: unknown;
  enabled?: unknown;
  note?: unknown;
};

function validateSiteKey(v: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof v !== "string" || !isSiteKey(v)) {
    return { ok: false, error: `site_key must be one of: ${SITE_KEYS.join(", ")}` };
  }
  return { ok: true, value: v };
}

function cleanNote(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, 300) : null;
}

export async function createRedirect(
  db: SupabaseClient | null,
  user: SessionUser | null,
  actor: SystemActor,
  input: RedirectInput,
  justification: string,
): Promise<SiteOpsResult> {
  if (!db) return fail(503, "Backend not configured");
  if (!user) return fail(401, "Unauthenticated");
  const site = validateSiteKey(input.site_key);
  if (!site.ok) return fail(400, site.error);
  // Runtime never applies redirects on console/API hosts (src/lib/site-redirects.ts
  // REDIRECT_DISABLED_SITES) — reject at write time so operators aren't misled.
  if (site.value === "system" || site.value === "api") {
    return fail(400, `site_key '${site.value}' is a console/API host — redirects are disabled there by design`);
  }
  const from = validateFromPath(input.from_path);
  if (!from.ok) return fail(400, from.error);
  const to = validateToPath(input.to_path);
  if (!to.ok) return fail(400, to.error);
  if (from.value === to.value && to.value.startsWith("/")) {
    return fail(400, "from_path and to_path are identical — nothing to redirect");
  }
  const g = await gate(db, actor, `siteops.redirect.create:${site.value}:${from.value}`, justification, riskFor("create"));
  if (!g.ok) return g.res;

  const { data, error } = await db.from("site_redirects").insert({
    site_key: site.value,
    from_path: from.value,
    to_path: to.value,
    enabled: input.enabled === undefined ? true : input.enabled === true,
    note: cleanNote(input.note),
    created_by: actor.id,
  }).select("id").single();
  if (error) {
    return fail(error.code === "23505" ? 409 : 500, error.code === "23505" ? `A redirect for ${site.value}${from.value} already exists` : (error.message ?? "insert failed"));
  }
  const id = (data as { id: string }).id;
  await audit(db, actor, "siteops.redirect_created", `site_redirect:${id}`, {
    site_key: site.value, from_path: from.value, to_path: to.value, change_request_id: g.changeRequestId,
  });
  return { ok: true, id, summary: `${site.value}${from.value} → ${to.value}` };
}

export async function updateRedirect(
  db: SupabaseClient | null,
  user: SessionUser | null,
  actor: SystemActor,
  id: string,
  patch: { to_path?: unknown; enabled?: unknown; note?: unknown },
  justification: string,
): Promise<SiteOpsResult> {
  if (!db) return fail(503, "Backend not configured");
  if (!user) return fail(401, "Unauthenticated");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(400, "Invalid redirect id");
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.to_path !== undefined) {
    const to = validateToPath(patch.to_path);
    if (!to.ok) return fail(400, to.error);
    update.to_path = to.value;
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") return fail(400, "enabled must be a boolean");
    update.enabled = patch.enabled;
  }
  if (patch.note !== undefined) update.note = cleanNote(patch.note);
  if (Object.keys(update).length === 1) return fail(400, "No fields to update");

  const g = await gate(db, actor, `siteops.redirect.update:${id}`, justification, riskFor(patch.enabled !== undefined && Object.keys(update).length === 2 ? "toggle" : "update"));
  if (!g.ok) return g.res;

  const { data, error } = await db.from("site_redirects").update(update).eq("id", id).select("id").maybeSingle();
  if (error) return fail(500, error.message ?? "update failed");
  if (!data) return fail(404, "Redirect not found");
  await audit(db, actor, "siteops.redirect_updated", `site_redirect:${id}`, { fields: Object.keys(update).filter((k) => k !== "updated_at"), change_request_id: g.changeRequestId });
  return { ok: true, id, summary: `Redirect ${id.slice(0, 8)} updated` };
}

export async function deleteRedirect(
  db: SupabaseClient | null,
  user: SessionUser | null,
  actor: SystemActor,
  id: string,
  justification: string,
): Promise<SiteOpsResult> {
  if (!db) return fail(503, "Backend not configured");
  if (!user) return fail(401, "Unauthenticated");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(400, "Invalid redirect id");
  const g = await gate(db, actor, `siteops.redirect.delete:${id}`, justification, riskFor("delete"));
  if (!g.ok) return g.res;

  const { data, error } = await db.from("site_redirects").delete().eq("id", id).select("id").maybeSingle();
  if (error) return fail(500, error.message ?? "delete failed");
  if (!data) return fail(404, "Redirect not found");
  await audit(db, actor, "siteops.redirect_deleted", `site_redirect:${id}`, { change_request_id: g.changeRequestId });
  return { ok: true, id, summary: `Redirect ${id.slice(0, 8)} deleted` };
}
