import type { SupabaseClient } from "@supabase/supabase-js";
import { INTEGRATION_PROVIDERS } from "./integrations";
import { roleCan, type SystemRole } from "./rbac";
import manifest from "./migrations-manifest.json";

/**
 * Federated global search for the system console (GET /api/system/search,
 * /system/search page).
 *
 * Hard rules:
 *  - TECHNICAL ENTITIES ONLY. Never searches profiles, customers, rentals PII,
 *    messages, or any table carrying customer personal data. Select lists are
 *    explicit — no `select("*")` anywhere in this module.
 *  - PERMISSION-AWARE: each entity group declares the SystemPermission needed
 *    to see it; groups the caller's role can't view are skipped entirely
 *    (not just filtered — never queried).
 *  - BOUNDED: query is sanitized to a safe charset, length-capped, and each
 *    entity returns at most PER_ENTITY rows. ilike wildcards (% _ \) and
 *    PostgREST .or() metacharacters ( ) , are stripped — they cannot be
 *    expressed through this interface.
 */

export const SEARCH_MIN_LEN = 2;
export const SEARCH_MAX_LEN = 100;
export const PER_ENTITY = 6;

/** Characters allowed in a search term: word chars plus the punctuation that
 *  legitimately appears in ids/uids/serials. Everything else is dropped. */
const SAFE_CHARS = /[^A-Za-z0-9 _.\-:/@+]/g;

export function sanitizeSearchQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(SAFE_CHARS, "").replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX_LEN);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SearchResultItem = {
  /** Entity type badge, e.g. "device", "command", "change". */
  type: string;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
  /** ISO timestamp used for display/sort, or null when the entity has none. */
  at: string | null;
};

export type SearchGroup = {
  type: string;
  label: string;
  items: SearchResultItem[];
};

export type SystemSearchResult = {
  q: string;
  groups: SearchGroup[];
  /** True when any entity hit its per-entity cap (results may be incomplete). */
  truncated: boolean;
};

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);
const iso = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);

/* ── Entity specs ──────────────────────────────────────────────────────── */

type EntitySpec = {
  type: string;
  label: string;
  /** System permission required to see this group at all. */
  perm: Parameters<typeof roleCan>[1];
  run: (db: SupabaseClient, q: string) => Promise<{ items: SearchResultItem[]; truncated: boolean }>;
};

const like = (q: string) => `%${q}%`;

/** ilike OR-filter over the given columns; uuid `idEq` adds an exact id match. */
function orFilter(cols: string[], q: string, idEq?: string | null): string {
  const parts = cols.map((c) => `${c}.ilike.${like(q)}`);
  if (idEq) parts.push(`id.eq.${idEq}`);
  return parts.join(",");
}

const SPECS: readonly EntitySpec[] = [
  {
    type: "device",
    label: "Devices",
    perm: "system.kiosks.view",
    run: async (db, q) => {
      const { data, error } = await db
        .from("system_devices")
        .select("id,device_uid,serial_number,model,status,last_heartbeat_at")
        .or(orFilter(["device_uid", "serial_number", "model"], q, UUID_RE.test(q) ? q : null))
        .order("created_at", { ascending: false })
        .limit(PER_ENTITY + 1);
      if (error) return { items: [], truncated: false };
      const rows = (data ?? []) as Row[];
      return {
        truncated: rows.length > PER_ENTITY,
        items: rows.slice(0, PER_ENTITY).map((r) => ({
          type: "device",
          id: str(r.device_uid) ?? str(r.serial_number) ?? str(r.id) ?? "?",
          title: str(r.device_uid) ?? str(r.serial_number) ?? "device",
          subtitle: [str(r.model), str(r.status)].filter(Boolean).join(" · ") || null,
          href: "/system/kiosks",
          at: iso(r.last_heartbeat_at),
        })),
      };
    },
  },
  {
    type: "command",
    label: "Commands",
    perm: "system.kiosks.view",
    run: async (db, q) => {
      const { data, error } = await db
        .from("device_commands")
        .select("id,command,status,created_at")
        .or(orFilter(["command", "idempotency_key"], q, UUID_RE.test(q) ? q : null))
        .order("created_at", { ascending: false })
        .limit(PER_ENTITY + 1);
      if (error) return { items: [], truncated: false };
      const rows = (data ?? []) as Row[];
      return {
        truncated: rows.length > PER_ENTITY,
        items: rows.slice(0, PER_ENTITY).map((r) => ({
          type: "command",
          id: str(r.id) ?? "?",
          title: str(r.command) ?? "command",
          subtitle: str(r.status),
          href: `/system/kiosks/commands/${str(r.id) ?? ""}`,
          at: iso(r.created_at),
        })),
      };
    },
  },
  {
    type: "exception",
    label: "Rental exceptions",
    perm: "system.kiosks.view",
    run: async (db, q) => {
      const { data, error } = await db
        .from("rental_exceptions")
        .select("id,kind,status,created_at")
        .or(orFilter(["kind"], q, UUID_RE.test(q) ? q : null))
        .order("created_at", { ascending: false })
        .limit(PER_ENTITY + 1);
      if (error) return { items: [], truncated: false };
      const rows = (data ?? []) as Row[];
      return {
        truncated: rows.length > PER_ENTITY,
        items: rows.slice(0, PER_ENTITY).map((r) => ({
          type: "exception",
          id: str(r.id) ?? "?",
          title: str(r.kind) ?? "exception",
          subtitle: str(r.status),
          href: `/system/kiosks/exceptions/${str(r.id) ?? ""}`,
          at: iso(r.created_at),
        })),
      };
    },
  },
  {
    type: "change",
    label: "Change requests",
    perm: "system.changes.view",
    run: async (db, q) => {
      const { data, error } = await db
        .from("system_change_requests")
        .select("id,action,risk,status,created_at")
        .or(orFilter(["action"], q, UUID_RE.test(q) ? q : null))
        .order("created_at", { ascending: false })
        .limit(PER_ENTITY + 1);
      if (error) return { items: [], truncated: false };
      const rows = (data ?? []) as Row[];
      return {
        truncated: rows.length > PER_ENTITY,
        items: rows.slice(0, PER_ENTITY).map((r) => ({
          type: "change",
          id: str(r.id) ?? "?",
          title: str(r.action) ?? "change request",
          subtitle: [str(r.risk), str(r.status)].filter(Boolean).join(" · ") || null,
          href: "/system/changes",
          at: iso(r.created_at),
        })),
      };
    },
  },
  {
    type: "incident",
    label: "Incidents",
    perm: "system.security.audit.view",
    run: async (db, q) => {
      const { data, error } = await db
        .from("incidents")
        .select("id,number,title,severity,status,detected_at")
        .or(orFilter(["number", "title", "summary"], q, UUID_RE.test(q) ? q : null))
        .order("detected_at", { ascending: false })
        .limit(PER_ENTITY + 1);
      if (error) return { items: [], truncated: false };
      const rows = (data ?? []) as Row[];
      return {
        truncated: rows.length > PER_ENTITY,
        items: rows.slice(0, PER_ENTITY).map((r) => ({
          type: "incident",
          id: str(r.number) ?? str(r.id) ?? "?",
          title: str(r.title) ?? "incident",
          subtitle: [str(r.severity), str(r.status)].filter(Boolean).join(" · ") || null,
          href: `/system/incidents/${str(r.id) ?? ""}`,
          at: iso(r.detected_at),
        })),
      };
    },
  },
  {
    type: "agent",
    label: "AI agents",
    perm: "system.ai.view",
    run: async (db, q) => {
      const { data, error } = await db
        .from("ai_agents")
        .select("id,name,description,enabled")
        .or(orFilter(["id", "name"], q))
        .order("id")
        .limit(PER_ENTITY + 1);
      if (error) return { items: [], truncated: false };
      const rows = (data ?? []) as Row[];
      return {
        truncated: rows.length > PER_ENTITY,
        items: rows.slice(0, PER_ENTITY).map((r) => ({
          type: "agent",
          id: str(r.id) ?? "?",
          title: str(r.name) ?? str(r.id) ?? "agent",
          subtitle: str(r.id),
          href: "/system/ai",
          at: null,
        })),
      };
    },
  },
  {
    type: "error",
    label: "Error issues",
    perm: "system.security.audit.view",
    run: async (db, q) => {
      const { data, error } = await db
        .from("error_issues")
        .select("id,fingerprint,title,culprit,severity,status,last_seen")
        .or(orFilter(["title", "fingerprint", "culprit"], q, UUID_RE.test(q) ? q : null))
        .order("last_seen", { ascending: false })
        .limit(PER_ENTITY + 1);
      if (error) return { items: [], truncated: false };
      const rows = (data ?? []) as Row[];
      return {
        truncated: rows.length > PER_ENTITY,
        items: rows.slice(0, PER_ENTITY).map((r) => ({
          type: "error",
          id: str(r.id) ?? "?",
          title: str(r.title) ?? "error issue",
          subtitle: [str(r.severity), str(r.status)].filter(Boolean).join(" · ") || null,
          href: "/system/observability/errors",
          at: iso(r.last_seen),
        })),
      };
    },
  },
  {
    type: "trace",
    label: "Traces",
    perm: "system.security.audit.view",
    run: async (db, q) => {
      const { data, error } = await db
        .from("trace_spans")
        .select("id,trace_id,name,service,status,created_at")
        .or(orFilter(["trace_id", "name", "service"], q))
        .order("created_at", { ascending: false })
        .limit(PER_ENTITY + 1);
      if (error) return { items: [], truncated: false };
      const rows = (data ?? []) as Row[];
      return {
        truncated: rows.length > PER_ENTITY,
        items: rows.slice(0, PER_ENTITY).map((r) => ({
          type: "trace",
          id: str(r.trace_id) ?? str(r.id) ?? "?",
          title: str(r.name) ?? "span",
          subtitle: [str(r.service), str(r.status)].filter(Boolean).join(" · ") || null,
          href: "/system/observability/traces",
          at: iso(r.created_at),
        })),
      };
    },
  },
  {
    type: "integration",
    label: "Integrations",
    perm: "system.integrations.view",
    run: async (_db, q) => {
      const needle = q.toLowerCase();
      const hits = INTEGRATION_PROVIDERS.filter(
        (p) => p.id.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle),
      ).slice(0, PER_ENTITY);
      return {
        truncated: false,
        items: hits.map((p) => ({
          type: "integration",
          id: p.id,
          title: p.name,
          subtitle: p.category,
          href: "/system/integrations",
          at: null,
        })),
      };
    },
  },
  {
    type: "migration",
    label: "Migrations",
    perm: "system.database.schema.view",
    run: async (_db, q) => {
      const needle = q.toLowerCase();
      const hits = (manifest.migrations as { file: string; number: number; title: string }[])
        .filter((m) => m.file.toLowerCase().includes(needle) || m.title.toLowerCase().includes(needle))
        .slice(0, PER_ENTITY);
      return {
        truncated: false,
        items: hits.map((m) => ({
          type: "migration",
          id: m.file,
          title: `#${m.number} ${m.title}`,
          subtitle: m.file,
          href: "/system/database/migrations",
          at: null,
        })),
      };
    },
  },
];

/**
 * Runs the federated search. `role` gates which entity groups are queried at
 * all; `db` is the service client. Returns honest empty groups for entities
 * whose query fails (missing table, etc.) — one bad entity never fails the
 * whole search.
 */
export async function systemSearch(
  db: SupabaseClient | null,
  role: SystemRole | null,
  rawQuery: unknown,
): Promise<SystemSearchResult> {
  const q = sanitizeSearchQuery(rawQuery);
  if (!db || !role || q.length < SEARCH_MIN_LEN) return { q, groups: [], truncated: false };

  const groups = await Promise.all(
    SPECS.filter((s) => roleCan(role, s.perm)).map(async (s) => {
      try {
        const { items, truncated } = await s.run(db, q);
        return items.length ? { type: s.type, label: s.label, items, truncated } : null;
      } catch {
        return null;
      }
    }),
  );

  const present = groups.filter((g): g is SearchGroup & { truncated: boolean } => g !== null);
  return {
    q,
    groups: present.map(({ type, label, items }) => ({ type, label, items })),
    truncated: present.some((g) => g.truncated),
  };
}

/** Exposed for tests: the entity registry (perm + table surface). */
export const SEARCH_SPECS = SPECS;
