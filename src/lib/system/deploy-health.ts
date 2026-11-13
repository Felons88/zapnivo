import type { SupabaseClient } from "@supabase/supabase-js";
import { recordLog } from "@/lib/observability";
import { baseDomain } from "@/lib/subdomains";
import { systemAudit, type SystemActor } from "./audit";

/**
 * Per-app deployment health profiles (Phase 3.2 hardening).
 *
 * Each profile is a small set of READ-ONLY checks against one production
 * host. Checks never authenticate, never touch payments/customer comms,
 * never send kiosk commands — they are unauthenticated GET/HEAD probes whose
 * expectations encode what the host is SUPPOSED to do for an anonymous
 * visitor (200 page, redirect-to-login gate, restricted wall, API 401).
 *
 * Honesty rules:
 *  - URLs are built ONLY from the profile's fixed host + a validated
 *    root-relative path, then re-checked against healthUrlAllowed()
 *    (https + approved host). Arbitrary URLs can never be fetched.
 *  - A check that gets no HTTP response at all is 'unreachable', not
 *    'unhealthy' — timeouts and DNS failures are reported distinctly.
 *  - 'degraded' requires a CRITICAL check failure; informational failures
 *    are recorded but do not degrade the verdict.
 *  - Results persist to uptime_checks (best-effort) + system_audit_events;
 *    nothing here writes customer-facing state.
 */

/* ── Profile definitions ───────────────────────────────────────────────── */

export type HealthCheckKind =
  | "http_status"          // GET/HEAD, follow redirects, expect final status
  | "auth_gate"            // must bounce anonymous users (login redirect / restricted wall)
  | "redirect"             // must 3xx to an expected host or same-host path
  | "no_cross_host_redirect" // must return expected status WITHOUT leaving the host
  | "api_readonly";        // safe GET on an /api/* path (usually expects 401/403)

export type HealthCheckDef = {
  id: string;
  kind: HealthCheckKind;
  /** Root-relative path only ("/…"). Defaults to "/". */
  path?: string;
  method?: "GET" | "HEAD";
  /**
   * http_status/api_readonly/no_cross_host_redirect: number[] of acceptable
   * final statuses. auth_gate: "login_redirect" | "auth_wall".
   * redirect: target — "/path" prefix (same host) or a hostname.
   */
  expect: number[] | string;
  /** When set, the response body (capped) must contain this string. */
  bodyIncludes?: string;
  critical: boolean;
  note?: string;
};

export type HealthAppProfile = {
  app: string;
  label: string;
  /** Host suffix under the base domain, e.g. "www" → www.zapnivo.com. */
  sub: string;
  checks: HealthCheckDef[];
};

const STATUS_200 = [200];
const AUTHED_REDIRECT = [401, 403]; // gated API proves route exists + auth enforced

/**
 * The 7 production surfaces. Behaviour verified against src/proxy.ts
 * (planRoute) + portal gates:
 *  - internal/partners/customer bounce anonymous → /login (307).
 *  - system renders a 200 "Access restricted" wall via SystemGate.
 *  - api.zapnivo.com answers GET / with {"service":"zapnivo-api","ok":true}
 *    and passes /api/* through to the route handlers.
 */
export const APP_PROFILES: readonly HealthAppProfile[] = [
  {
    app: "www", label: "Marketing site (www)", sub: "www",
    checks: [
      { id: "home", kind: "no_cross_host_redirect", path: "/", expect: STATUS_200, critical: true,
        note: "canonical host must serve 200 directly — no redirect off www" },
      { id: "locations", kind: "http_status", path: "/locations", expect: STATUS_200, critical: false },
      { id: "api_surface", kind: "api_readonly", path: "/api/system/status", expect: AUTHED_REDIRECT, critical: false,
        note: "gated API must reject anonymous reads — 401/403 proves route + auth live" },
    ],
  },
  {
    app: "customer", label: "Customer portal", sub: "customer",
    checks: [
      { id: "root_gate", kind: "auth_gate", path: "/", expect: "login_redirect", critical: true,
        note: "customer.zapnivo.com/ rewrites to /account → anonymous must redirect to /login" },
      { id: "account_gate", kind: "auth_gate", path: "/account", expect: "login_redirect", critical: false },
      { id: "api_surface", kind: "api_readonly", path: "/api/system/status", expect: AUTHED_REDIRECT, critical: false },
    ],
  },
  {
    app: "partners", label: "Partner portal", sub: "partners",
    checks: [
      { id: "root_gate", kind: "auth_gate", path: "/", expect: "login_redirect", critical: true,
        note: "partners.zapnivo.com/ rewrites to /partners → anonymous must redirect to /login" },
      { id: "partners_gate", kind: "auth_gate", path: "/partners", expect: "login_redirect", critical: false },
      { id: "api_surface", kind: "api_readonly", path: "/api/system/status", expect: AUTHED_REDIRECT, critical: false },
    ],
  },
  {
    app: "support", label: "Support center", sub: "support",
    checks: [
      { id: "home", kind: "http_status", path: "/", expect: STATUS_200, critical: true,
        note: "support.zapnivo.com/ rewrites to /support — public help center" },
      { id: "articles", kind: "http_status", path: "/support/articles", expect: STATUS_200, critical: false },
      { id: "api_surface", kind: "api_readonly", path: "/api/system/status", expect: AUTHED_REDIRECT, critical: false },
    ],
  },
  {
    app: "internal", label: "Staff console (admin)", sub: "internal",
    checks: [
      { id: "root_gate", kind: "auth_gate", path: "/", expect: "login_redirect", critical: true,
        note: "internal.zapnivo.com/ rewrites to /admin → anonymous must redirect to /login" },
      { id: "admin_gate", kind: "auth_gate", path: "/admin", expect: "login_redirect", critical: false },
      { id: "api_surface", kind: "api_readonly", path: "/api/system/status", expect: AUTHED_REDIRECT, critical: false },
    ],
  },
  {
    app: "api", label: "API edge", sub: "api",
    checks: [
      { id: "service_root", kind: "http_status", path: "/", expect: STATUS_200, critical: true,
        bodyIncludes: '"ok":true',
        note: "api.zapnivo.com answers {service:'zapnivo-api',ok:true} — proves proxy + app serving" },
      { id: "api_surface", kind: "api_readonly", path: "/api/system/status", expect: AUTHED_REDIRECT, critical: false,
        note: "/api/* passes through on the api host → gated route must 401 anonymously" },
      { id: "robots", kind: "http_status", path: "/robots.txt", expect: STATUS_200, critical: false },
    ],
  },
  {
    app: "system", label: "System console", sub: "system",
    checks: [
      { id: "console_wall", kind: "auth_gate", path: "/", expect: "auth_wall", critical: true,
        bodyIncludes: "Access restricted",
        note: "system.zapnivo.com/ rewrites to /system — SystemGate renders a 200 restricted wall, never app data" },
      { id: "system_path_wall", kind: "auth_gate", path: "/system", expect: "auth_wall", critical: false,
        bodyIncludes: "Access restricted" },
      { id: "api_surface", kind: "api_readonly", path: "/api/system/status", expect: AUTHED_REDIRECT, critical: false },
    ],
  },
];

/** "apex" is an alias for the canonical marketing host (www). */
const APP_ALIASES: Record<string, string> = { apex: "www", zapnivo: "www" };

export type ResolvedHealthProfile = HealthAppProfile & { host: string };

export function healthProfileFor(app: string): ResolvedHealthProfile | null {
  const key = APP_ALIASES[app] ?? app;
  const p = APP_PROFILES.find((x) => x.app === key);
  if (!p) return null;
  return { ...p, host: profileHost(p) };
}

export function healthProfileApps(): { app: string; label: string; host: string; checks: number }[] {
  return APP_PROFILES.map((p) => ({ app: p.app, label: p.label, host: profileHost(p), checks: p.checks.length }));
}

function profileHost(p: HealthAppProfile): string {
  return `${p.sub}.${baseDomain()}`;
}

/* ── URL allowlist ─────────────────────────────────────────────────────── */

/**
 * Health checks may only ever fetch https URLs on:
 *  - the profile's own production host (*.baseDomain — zapnivo.com by default),
 *  - *.vercel.app deployment URLs, or
 *  - hosts in DEPLOY_PROBE_DOMAINS.
 * Mirrors probeableUrl()'s conservatism; arbitrary hosts are refused.
 */
export function healthUrlAllowed(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  const base = baseDomain();
  if (host === base || host.endsWith(`.${base}`)) return true;
  if (host === "vercel.app" || host.endsWith(".vercel.app")) return true;
  const extra = (process.env.DEPLOY_PROBE_DOMAINS ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return extra.includes(host);
}

/** Builds the check URL; returns null for invalid paths/hosts. */
function checkUrl(profile: HealthAppProfile & { host: string }, def: HealthCheckDef): string | null {
  const path = def.path ?? "/";
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..") || /[\s\\]/.test(path)) return null;
  const url = `https://${profile.host}${path}`;
  return healthUrlAllowed(url) ? url : null;
}

/* ── Runner ────────────────────────────────────────────────────────────── */

export type HealthCheckResult = {
  id: string;
  kind: HealthCheckKind;
  critical: boolean;
  ok: boolean;
  /** HTTP status observed, or null when no response completed. */
  status: number | null;
  latencyMs: number | null;
  /** True when an HTTP response was received (vs timeout/DNS/refused). */
  responded: boolean;
  url: string | null;
  detail: string;
};

export type HealthProfileResult = {
  app: string;
  host: string;
  ranAt: string;
  status: "healthy" | "degraded" | "unreachable";
  checks: HealthCheckResult[];
  checksOk: number;
  checksTotal: number;
  criticalFailures: string[];
  informationalFailures: string[];
};

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_CONCURRENCY = 4;
const BODY_CAP = 64 * 1024;

function expectStatuses(def: HealthCheckDef): number[] {
  return Array.isArray(def.expect) ? def.expect : [];
}

/** Reads at most BODY_CAP chars — enough for marker checks, never a dump. */
async function readCapped(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, BODY_CAP);
  } catch {
    return "";
  }
}

async function runOneCheck(
  profile: HealthAppProfile & { host: string },
  def: HealthCheckDef,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<HealthCheckResult> {
  const base: HealthCheckResult = {
    id: def.id, kind: def.kind, critical: def.critical,
    ok: false, status: null, latencyMs: null, responded: false, url: null, detail: "",
  };
  const url = checkUrl(profile, def);
  if (!url) {
    return { ...base, detail: "check URL rejected by allowlist/path validation — never fetched" };
  }
  const started = performance.now();
  const done = (patch: Partial<HealthCheckResult>) =>
    ({ ...base, url, latencyMs: Math.round(performance.now() - started), ...patch });

  const needsBody = typeof def.bodyIncludes === "string" || def.expect === "auth_wall";
  const manual = def.kind === "auth_gate" || def.kind === "redirect" || def.kind === "no_cross_host_redirect";

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: def.method ?? "GET",
      redirect: manual ? "manual" : "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "ZapnivoHealthProfile/1.0", accept: "*/*" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.name === "TimeoutError" || e.name === "AbortError" ? "timed out" : "request failed" : "request failed";
    return done({ detail: `${msg} after ${Math.round(performance.now() - started)}ms — no HTTP response` });
  }

  const status = res.status;
  const responded = { responded: true, status };

  // Location header for redirect-style checks (manual mode only).
  const location = res.headers.get("location");

  let ok = false;
  let detail = `HTTP ${status}`;

  if (def.kind === "http_status" || def.kind === "api_readonly") {
    ok = expectStatuses(def).includes(status);
    detail = ok ? `HTTP ${status}` : `HTTP ${status} — expected ${expectStatuses(def).join("/")}`;
  } else if (def.kind === "no_cross_host_redirect") {
    ok = expectStatuses(def).includes(status);
    if (ok && status >= 300 && status < 400 && location) {
      try {
        const locHost = new URL(location, url).hostname.toLowerCase();
        if (locHost !== profile.host) {
          ok = false;
          detail = `HTTP ${status} redirected cross-host to ${locHost} — unexpected`;
        }
      } catch { /* relative Location already covered */ }
    }
    if (ok) detail = `HTTP ${status} (no cross-host redirect)`;
    else if (!detail.includes("cross-host")) detail = `HTTP ${status} — expected ${expectStatuses(def).join("/")}`;
  } else if (def.kind === "redirect") {
    ok = status >= 300 && status < 400 && typeof def.expect === "string" && location !== null;
    if (ok) {
      const target = def.expect as string;
      try {
        const loc = new URL(location as string, url);
        ok = target.startsWith("/")
          ? loc.hostname === profile.host && loc.pathname.startsWith(target)
          : loc.hostname.toLowerCase() === target.toLowerCase();
      } catch { ok = false; }
    }
    detail = ok
      ? `HTTP ${status} → ${location}`
      : `HTTP ${status}${location ? ` → ${location}` : " (no Location)"} — expected redirect to ${String(def.expect)}`;
  } else if (def.kind === "auth_gate") {
    if (def.expect === "login_redirect") {
      ok = status >= 300 && status < 400 && location !== null;
      if (ok) {
        try {
          const loc = new URL(location as string, url);
          ok = loc.hostname === profile.host && loc.pathname.startsWith("/login");
        } catch { ok = false; }
      }
      detail = ok ? `HTTP ${status} → login (gate enforced)` : `HTTP ${status}${location ? ` → ${location}` : ""} — anonymous access NOT redirected to /login`;
    } else {
      // "auth_wall": page renders (200) but must show the restricted marker,
      // never app content. This is the honest system-console contract.
      const body = needsBody ? await readCapped(res) : "";
      const marker = def.bodyIncludes ?? "Access restricted";
      ok = status === 200 && body.includes(marker);
      detail = ok
        ? `HTTP 200 restricted wall ("${marker}")`
        : status === 200
          ? `HTTP 200 but restricted marker "${marker}" absent — possible auth bypass`
          : `HTTP ${status} — expected 200 restricted wall`;
    }
  }

  // bodyIncludes applies to http_status/api_readonly too (e.g. api root JSON).
  if (ok && typeof def.bodyIncludes === "string" && (def.kind === "http_status" || def.kind === "api_readonly")) {
    const body = await readCapped(res);
    if (!body.includes(def.bodyIncludes)) {
      ok = false;
      detail = `HTTP ${status} but body missing marker "${def.bodyIncludes}"`;
    } else {
      detail = `HTTP ${status} + body marker`;
    }
  }

  return done({ ...responded, ok, detail: detail.slice(0, 300) });
}

/**
 * Runs every check in a profile with bounded concurrency (≤4) and a
 * per-check timeout. Never throws for check-level failures — the result
 * carries honest per-check detail. Throws only for an unknown app key.
 */
export async function runHealthProfile(
  app: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<HealthProfileResult> {
  const profile = healthProfileFor(app);
  if (!profile) throw new Error(`unknown health profile '${app}' — known: ${APP_PROFILES.map((p) => p.app).join(", ")}`);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const results: HealthCheckResult[] = new Array(profile.checks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, profile.checks.length) }, async () => {
    while (next < profile.checks.length) {
      const i = next++;
      results[i] = await runOneCheck(profile, profile.checks[i], timeoutMs, fetchImpl);
    }
  });
  await Promise.all(workers);

  const checks = results;
  const responded = checks.filter((c) => c.responded).length;
  const criticalFailures = checks.filter((c) => !c.ok && c.critical).map((c) => c.id);
  const informationalFailures = checks.filter((c) => !c.ok && !c.critical).map((c) => c.id);
  const status: HealthProfileResult["status"] =
    responded === 0 ? "unreachable"
    : criticalFailures.length > 0 ? "degraded"
    : "healthy";

  return {
    app: profile.app,
    host: profile.host,
    ranAt: new Date().toISOString(),
    status,
    checks,
    checksOk: checks.filter((c) => c.ok).length,
    checksTotal: checks.length,
    criticalFailures,
    informationalFailures,
  };
}

/* ── Recording ─────────────────────────────────────────────────────────── */

/**
 * Persists a profile run: one uptime_checks row per check (best-effort —
 * observability pages already read that table) plus app_logs. Never throws.
 */
export async function recordHealthProfile(db: SupabaseClient | null, result: HealthProfileResult): Promise<void> {
  if (!db) return;
  try {
    const rows = result.checks.map((c) => ({
      url: c.url ?? `https://${result.host}/${c.id}`,
      ok: c.ok,
      status_code: c.status,
      latency_ms: c.latencyMs,
    }));
    if (rows.length) {
      await db.from("uptime_checks").insert(rows);
    }
  } catch { /* observability write is best-effort */ }
  recordLog(result.status === "healthy" ? "info" : "warning",
    `deploy health profile ${result.app} (${result.host}) → ${result.status} (${result.checksOk}/${result.checksTotal} ok)`,
    { service: "deployments", attrs: { app: result.app, host: result.host, status: result.status, critical_failures: result.criticalFailures } });
}

/**
 * Audits a profile run. 'deployment.health_profile' on every recorded run;
 * an additional 'deployment.health_degraded' when the verdict is degraded
 * and the previous recorded status wasn't already degraded (transition-only,
 * mirroring auditHealth in deploy-center). prevStatus=null → first run.
 */
export async function auditHealthProfile(
  db: SupabaseClient,
  actor: SystemActor,
  result: HealthProfileResult,
  prevStatus: string | null,
): Promise<void> {
  const detail = {
    app: result.app,
    host: result.host,
    health_status: result.status,
    checks_ok: result.checksOk,
    checks_total: result.checksTotal,
    critical_failures: result.criticalFailures.slice(0, 20),
    informational_failures: result.informationalFailures.slice(0, 20),
  };
  await systemAudit(db, {
    actor,
    action: "deployment.health_profile",
    resource: `health_profile:${result.app}`,
    detail,
  });
  if (result.status === "degraded" && prevStatus !== "degraded") {
    await systemAudit(db, {
      actor,
      action: "deployment.health_degraded",
      resource: `health_profile:${result.app}`,
      detail: { ...detail, note: "critical health-profile check failed after deploy — manual review required; NO auto-rollback is performed" },
    });
  }
}

/**
 * Run + record + audit in one call. Used by the standalone API route and by
 * deploy-center's post-ready monitor pass. Check-level failures never throw;
 * DB writes are best-effort.
 */
export async function runAndRecordHealthProfile(
  db: SupabaseClient | null,
  actor: SystemActor,
  app: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch; prevStatus?: string | null } = {},
): Promise<HealthProfileResult> {
  const result = await runHealthProfile(app, { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl });
  await recordHealthProfile(db, result);
  if (db) await auditHealthProfile(db, actor, result, opts.prevStatus ?? null);
  return result;
}
