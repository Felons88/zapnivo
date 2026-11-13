import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Route inventory for /system/infrastructure/api (+ GET
 * /api/system/infrastructure/api-services).
 *
 * This is an honest ROUTE INVENTORY, not monitoring: every route.ts under
 * src/app/api is scanned at request time. The auth column is classified by
 * DETECTING guard calls/tokens in the route source (systemApiGuard,
 * requireSystem, CRON_SECRET, KIOSK_INGEST_SECRET/verifyDeviceAuth, provider
 * webhook signature checks, session helpers) with a path-based heuristic as
 * fallback. Anything not confidently detected is labeled "unclassified" —
 * never guessed.
 */

export type AuthClass =
  | "system_rbac"
  | "cron_secret"
  | "device_ingest"
  | "provider_webhook"
  | "session"
  | "staff"
  | "partner"
  | "support_token"
  | "dev_only"
  | "public_or_unclassified";

export type RouteEntry = {
  /** e.g. /api/system/webhooks/[id]/replay */
  path: string;
  methods: string[];
  /** First path segment after /api ("system", "cron", "webhooks", …). */
  domain: string;
  auth: AuthClass;
  /** Human-readable auth requirement (permission string when system_rbac). */
  authDetail: string;
  /** "detected" = guard token found in source; "heuristic" = path-based guess. */
  authSource: "detected" | "heuristic";
  /** error_events rows seen for this route label (last 24h / all-time recent). */
  errors24h?: number | null;
  errorsRecent?: number | null;
};

export type ApiInventory = {
  generatedAt: string;
  apiRoot: string;
  routeCount: number;
  routes: RouteEntry[];
  domains: { domain: string; routes: number }[];
  note: string;
};

const API_ROOT = path.join(process.cwd(), "src", "app", "api");
const METHOD_RE = /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;

function routePathFromFile(file: string): string {
  const rel = path.relative(API_ROOT, file).replace(/\\/g, "/").replace(/\/route\.ts$/, "");
  return `/api/${rel}`;
}

function domainOf(routePath: string): string {
  const seg = routePath.split("/").filter(Boolean)[1] ?? "";
  return seg || "(root)";
}

export type Classification = { auth: AuthClass; authDetail: string; authSource: "detected" | "heuristic"; perm?: string };

/**
 * Classify a route by guard tokens found in its source. Order matters: the
 * most specific guards win. Returns authSource "heuristic" only when nothing
 * matched — the detail string says so honestly.
 */
export function classifyRouteSource(source: string, routePath: string): Classification {
  const has = (re: RegExp) => re.test(source);

  // System control plane — strongest signal.
  const guardPerm = source.match(/systemApiGuard\(\s*["'`]([\w.]+)["'`]/) ?? source.match(/requireSystem\(\s*["'`]([\w.]+)["'`]/);
  if (guardPerm || has(/\bsystemApiGuard\b|\brequireSystem\b/)) {
    return {
      auth: "system_rbac",
      authDetail: guardPerm ? `systemApiGuard(${guardPerm[1]})` : "requireSystem() (permission arg not statically resolved)",
      authSource: "detected",
      perm: guardPerm?.[1],
    };
  }

  // Cron endpoints: CRON_SECRET bearer (some also accept staff session).
  if (has(/CRON_SECRET/) || has(/authorization.*Bearer/i) && routePath.startsWith("/api/cron")) {
    const staffFallback = has(/isStaff|getSessionUser|requireStaff/);
    return {
      auth: "cron_secret",
      authDetail: staffFallback ? "Bearer CRON_SECRET (staff session also accepted)" : "Bearer CRON_SECRET",
      authSource: "detected",
    };
  }
  if (routePath.startsWith("/api/cron")) {
    return { auth: "cron_secret", authDetail: "cron route — CRON_SECRET expected (not detected in source)", authSource: "heuristic" };
  }

  // Device ingest: HMAC device auth and/or legacy KIOSK_INGEST_SECRET bearer.
  if (has(/verifyDeviceAuth|KIOSK_INGEST_SECRET|device_secret/)) {
    return { auth: "device_ingest", authDetail: "device HMAC auth and/or KIOSK_INGEST_SECRET bearer", authSource: "detected" };
  }

  // Provider webhooks: signature/secret verification.
  if (has(/constructEvent|STRIPE_WEBHOOK_SECRET|stripe\.webhooks/)) {
    return { auth: "provider_webhook", authDetail: "Stripe webhook signature verification", authSource: "detected" };
  }
  if (has(/TWILIO_AUTH_TOKEN|validateRequest|twilio.*signature/i)) {
    return { auth: "provider_webhook", authDetail: "Twilio request-signature validation", authSource: "detected" };
  }
  if (has(/EMAIL_INBOUND_SECRET/)) {
    return { auth: "provider_webhook", authDetail: "EMAIL_INBOUND_SECRET shared-secret check", authSource: "detected" };
  }

  // Dev-only tooling.
  if (routePath.startsWith("/api/dev") || has(/devAuth\(\)|HELPDESK_DEV_STORE/)) {
    return { auth: "dev_only", authDetail: "development-only surface (devAuth / HELPDESK_DEV_STORE)", authSource: has(/devAuth|HELPDESK_DEV_STORE/) ? "detected" : "heuristic" };
  }

  // Support thread access tokens.
  if (has(/HELPDESK_SECRET|threadToken|accessToken.*helpdesk|verifyThreadToken/i)) {
    return { auth: "support_token", authDetail: "signed helpdesk thread token", authSource: "detected" };
  }

  // Session-based areas.
  if (has(/getSessionUser|auth\.getUser|supabase\.auth\.getUser|getUser\(\)/)) {
    if (has(/isStaff|requireStaff|is_staff\(\)/)) {
      return { auth: "staff", authDetail: "staff session (is_staff)", authSource: "detected" };
    }
    if (routePath.startsWith("/api/partners") || has(/partner/i) && has(/organization_id|partner_role/)) {
      return { auth: "partner", authDetail: "partner session (organization-scoped)", authSource: "detected" };
    }
    return { auth: "session", authDetail: "authenticated session", authSource: "detected" };
  }

  // Path heuristics for routes whose guard is indirect (service helpers).
  if (routePath.startsWith("/api/admin")) {
    return { auth: "staff", authDetail: "admin area — staff session expected (guard not statically detected)", authSource: "heuristic" };
  }
  if (routePath.startsWith("/api/partners")) {
    return { auth: "partner", authDetail: "partner area — partner session expected (guard not statically detected)", authSource: "heuristic" };
  }
  if (routePath.startsWith("/api/support")) {
    return { auth: "support_token", authDetail: "support area — session or thread token (guard not statically detected)", authSource: "heuristic" };
  }

  return {
    auth: "public_or_unclassified",
    authDetail: "no guard tokens detected in source — may be intentionally public (checkout, health, marketing forms) or guarded indirectly",
    authSource: "heuristic",
  };
}

function* walkRoutes(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walkRoutes(full);
    else if (name === "route.ts" || name === "route.tsx") yield full;
  }
}

const SOURCE_READ_LIMIT = 60_000; // chars — route files are small; bound anyway

/** Scans src/app/api at request time. Never throws — unreadable dirs yield empty. */
export function scanApiInventory(apiRoot: string = API_ROOT): ApiInventory {
  const routes: RouteEntry[] = [];
  for (const file of walkRoutes(apiRoot)) {
    let source = "";
    try {
      source = readFileSync(file, "utf8").slice(0, SOURCE_READ_LIMIT);
    } catch {
      source = "";
    }
    const routePath = routePathFromFile(file);
    const methods = [...source.matchAll(METHOD_RE)].map((m) => m[1]).sort();
    const cls = classifyRouteSource(source, routePath);
    routes.push({
      path: routePath,
      methods: methods.length ? [...new Set(methods)] : ["?"],
      domain: domainOf(routePath),
      auth: cls.auth,
      authDetail: cls.authDetail,
      authSource: cls.authSource,
    });
  }
  routes.sort((a, b) => a.path.localeCompare(b.path));
  const domainMap = new Map<string, number>();
  for (const r of routes) domainMap.set(r.domain, (domainMap.get(r.domain) ?? 0) + 1);
  const domains = [...domainMap.entries()].map(([domain, routes]) => ({ domain, routes })).sort((a, b) => b.routes - a.routes);
  return {
    generatedAt: new Date().toISOString(),
    apiRoot: "/api",
    routeCount: routes.length,
    routes,
    domains,
    note: "Route inventory scanned from src/app/api/**/route.ts at request time. Auth is classified by guard tokens detected in each route's source (systemApiGuard/requireSystem perms, CRON_SECRET, device HMAC/KIOSK_INGEST_SECRET, provider signature checks, session helpers) with a path heuristic fallback — 'unclassified' means no guard was statically detected, NOT that the route is public. This is inventory, not uptime monitoring; per-route error signal comes from error_events where a route label was recorded.",
  };
}

/** Attach error_events counts (last 24h + recent) to inventory routes — best-effort, read-only. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export async function attachRouteErrors(db: Db, routes: RouteEntry[]): Promise<void> {
  if (!db) return;
  try {
    const since24 = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { data } = await db
      .from("error_events")
      .select("route,occurred_at")
      .not("route", "is", null)
      .order("occurred_at", { ascending: false })
      .limit(2000);
    const rows = (data ?? []) as { route: string; occurred_at: string }[];
    const byRoute = new Map<string, { e24: number; recent: number }>();
    for (const r of rows) {
      const e = byRoute.get(r.route) ?? { e24: 0, recent: 0 };
      e.recent += 1;
      if (r.occurred_at >= since24) e.e24 += 1;
      byRoute.set(r.route, e);
    }
    for (const route of routes) {
      // error_events.route is a free-form label; match exact or suffix.
      const exact = byRoute.get(route.path);
      const suffix = [...byRoute.entries()].find(([k]) => k === route.path || k.endsWith(route.path) || route.path.endsWith(k));
      const hit = exact ?? suffix?.[1];
      route.errors24h = hit?.e24 ?? 0;
      route.errorsRecent = hit?.recent ?? 0;
    }
  } catch {
    /* error attachment is best-effort */
  }
}
