import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * System audit activity feed (system_audit_events) for /system/activity.
 *
 * The table is append-only (select-only RLS) and `detail` is sanitized at
 * write time by sanitizeAuditDetail (src/lib/system/audit.ts) — this module
 * only reads, never writes, and never re-selects secret material.
 *
 * Pagination is a (created_at, id) keyset cursor, base64-encoded as an opaque
 * `cursor` token: rows are ordered created_at DESC, id DESC; the next page is
 * everything strictly "before" the cursor tuple.
 */

export const ACTIVITY_PAGE_SIZE = 50;
export const ACTIVITY_MAX_LIMIT = 100;

export type ActivityRow = {
  id: number | string;
  actor_id: string | null;
  actor_role: string;
  action: string;
  resource: string;
  environment: string;
  detail: Record<string, unknown>;
  correlation_id: string | null;
  created_at: string;
};

export type ActivityFilters = {
  /** Exact actor_id (uuid) — staff user id. */
  actor?: string;
  /** Exact actor_role (e.g. "sysadmin", "breakglass", "system"). */
  actorRole?: string;
  /** Action prefix, e.g. "change." or "device." — sanitized, max 60 chars. */
  actionPrefix?: string;
  /** Resource type prefix before the ':' — e.g. "device_command", "system_device". */
  resourceType?: string;
  /** ISO timestamps bounding created_at. */
  from?: string;
  to?: string;
};

const SAFE = /^[A-Za-z0-9_.:-]{1,80}$/;
const safeToken = (v: string | undefined): string | null =>
  v && SAFE.test(v) ? v : null;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string): string | null => {
  try { return Buffer.from(s, "base64url").toString("utf8"); } catch { return null; }
};

export type ActivityCursor = { created_at: string; id: string };

export function encodeCursor(c: ActivityCursor): string {
  return b64(`${c.created_at}|${c.id}`);
}

export function decodeCursor(raw: string | undefined | null): ActivityCursor | null {
  if (!raw || raw.length > 200) return null;
  const s = unb64(raw);
  if (!s) return null;
  const i = s.indexOf("|");
  if (i <= 0) return null;
  const created_at = s.slice(0, i);
  const id = s.slice(i + 1);
  if (!created_at || !id || created_at.length > 60 || id.length > 60) return null;
  if (Number.isNaN(Date.parse(created_at))) return null;
  return { created_at, id };
}

const SELECT = "id,actor_id,actor_role,action,resource,environment,detail,correlation_id,created_at";

/**
 * One page of audit events, newest first. Returns `nextCursor` (opaque token
 * for the following page) or null at the end. Filters are all optional and
 * strictly sanitized — a bad filter value is ignored, never interpolated raw.
 */
export async function listActivity(
  db: SupabaseClient | null,
  opts: ActivityFilters & { cursor?: string; limit?: number } = {},
): Promise<{ configured: boolean; rows: ActivityRow[]; nextCursor: string | null }> {
  if (!db) return { configured: false, rows: [], nextCursor: null };
  const limit = Math.min(Math.max(opts.limit ?? ACTIVITY_PAGE_SIZE, 1), ACTIVITY_MAX_LIMIT);

  let q = db.from("system_audit_events").select(SELECT)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  const actor = safeToken(opts.actor);
  if (actor) q = q.eq("actor_id", actor);
  const actorRole = safeToken(opts.actorRole);
  if (actorRole) q = q.eq("actor_role", actorRole);
  const prefix = safeToken(opts.actionPrefix);
  if (prefix) q = q.like("action", `${prefix}%`);
  const rtype = safeToken(opts.resourceType);
  if (rtype) q = q.like("resource", `${rtype}:%`);
  if (opts.from && !Number.isNaN(Date.parse(opts.from))) q = q.gte("created_at", new Date(opts.from).toISOString());
  if (opts.to && !Number.isNaN(Date.parse(opts.to))) q = q.lte("created_at", new Date(opts.to).toISOString());

  const cursor = decodeCursor(opts.cursor);
  if (cursor) {
    // Keyset: rows strictly before (created_at, id) in DESC order.
    q = q.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
  }

  const { data, error } = await q;
  if (error) return { configured: true, rows: [], nextCursor: null };
  const rows = (data ?? []) as ActivityRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last
    ? encodeCursor({ created_at: last.created_at, id: String(last.id) })
    : null;
  return { configured: true, rows: page, nextCursor };
}

/**
 * Maps an audit `resource` identifier ("type:id", written by server code) to
 * the console page that owns it. Returns null for resources with no detail
 * view — the feed renders them as plain text, never a dead link.
 */
export function resourceHref(resource: string): string | null {
  const idx = resource.indexOf(":");
  if (idx <= 0) return null;
  const type = resource.slice(0, idx);
  const id = resource.slice(idx + 1);
  // Ids that go into a path segment: no slashes/colons/spaces — anything else
  // falls back to the list page so a crafted resource can't path-traverse.
  const safeId = /^[A-Za-z0-9_.-]{1,120}$/.test(id) ? id : null;
  switch (type) {
    case "device_command":
      return safeId ? `/system/kiosks/commands/${safeId}` : "/system/kiosks/commands";
    case "system_device":
      return "/system/kiosks";
    case "kiosk":
      return safeId ? `/system/kiosks/${safeId}` : "/system/kiosks";
    case "rental_exception":
      return safeId ? `/system/kiosks/exceptions/${safeId}` : "/system/kiosks/exceptions";
    case "incident":
      return safeId ? `/system/incidents/${safeId}` : "/system/incidents";
    case "change_request":
      return "/system/changes";
    case "feature_flag":
      return "/system/settings/flags";
    case "secret":
      return "/system/secrets";
    case "integration":
      return "/system/integrations";
    case "ai_agent":
      return "/system/ai";
    case "webhook":
      return "/system/webhooks";
    case "deployment_request":
      return "/system/app";
    case "recovery_test":
      return "/system/recovery";
    case "profile":
      return "/system/security/users";
    case "inbound_jobs":
    case "email_outbox":
      return "/system/jobs";
    default:
      return null;
  }
}
