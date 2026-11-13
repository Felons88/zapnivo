import { baseDomain, siteKeyForHost, type SiteKey } from "./subdomains";

/**
 * Runtime enforcement for DB-driven site redirects (site_redirects, migration
 * 0062). Rows are written/audited by src/lib/system/site-ops.ts via
 * /system/sites/ops; this module is the READ side consumed by src/proxy.ts.
 *
 * Design notes:
 *  - Runs inside the Next.js proxy (Node.js runtime in Next 16 — see
 *    node_modules/next/dist/docs/.../proxy.md). Uses a plain PostgREST fetch
 *    (not supabase-js) so there is no per-request client construction and the
 *    call works in any JS runtime with fetch.
 *  - The full enabled rule set is cached in module memory for TTL_MS (60s).
 *    Proxy/admin writes cannot bust this cache, so a new/edited redirect can
 *    take up to ~60s to take effect — acceptable for operator-managed rules.
 *    On fetch failure the last good cache is served indefinitely (stale beats
 *    none: a missed redirect is safer than a wrong one).
 *  - Rows are capped at MAX_ROWS; the table is operator-managed and tiny.
 *  - Status code: the schema has no permanent/temporary column, so ALL
 *    redirects are issued as 307 (temporary) — never cached by browsers/CDNs
 *    as permanent. Revisit if a `permanent` flag is ever added (migration).
 *  - Redirect hits are NOT audited per-request (high volume); admin CRUD is
 *    already audited in site-ops.ts.
 */

export type RedirectRule = { site_key: string; from_path: string; to_path: string };

const TTL_MS = 60_000;
const MAX_ROWS = 500;
const FETCH_TIMEOUT_MS = 2_500;
/** Total rule applications allowed while resolving a chain (1 = no chaining). */
const MAX_CHAIN_HOPS = 2;

/* ── Path / target validation (mirrors src/lib/system/site-ops.ts rules —
 *    duplicated here because site-ops pulls server audit deps that must not
 *    enter the proxy bundle; keep the two in sync) ────────────────────────── */

const FROM_PATH_RE = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#[\]]*$/;
const MAX_PATH = 500;

const ALLOWED_TARGET_HOSTS = new Set(["zapnivo.com", "www.zapnivo.com", "localhost"]);
const ALLOWED_TARGET_SUFFIXES = [".zapnivo.com", ".localhost"];

const isAllowedTargetHost = (hostname: string): boolean => {
  const h = hostname.toLowerCase();
  return ALLOWED_TARGET_HOSTS.has(h) || ALLOWED_TARGET_SUFFIXES.some((s) => h.endsWith(s));
};

/** Relative-path check equivalent to site-ops validateFromPath (query/hash allowed in stored form). */
function isCleanRelativePath(v: string): boolean {
  return (
    v.length > 0 &&
    v.length <= MAX_PATH &&
    v.startsWith("/") &&
    !v.startsWith("//") &&
    !/\s/.test(v) &&
    !v.includes("://") &&
    !v.includes("..") &&
    FROM_PATH_RE.test(v)
  );
}

/**
 * Read-side re-validation of to_path (defense in depth — write path already
 * validates, but rows could be inserted out-of-band). Accepts a relative path
 * or an absolute https URL on an approved Zapnivo/localhost host. Anything
 * else (external hosts, http non-local, javascript:, malformed) → null.
 */
export function validateRedirectTarget(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 2000) return null;
  if (s.startsWith("/")) return isCleanRelativePath(s) ? s : null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  if (!isAllowedTargetHost(url.hostname)) return null;
  return url.toString();
}

/* ── Protected paths — never redirected regardless of DB rows ────────────── */

/** Segment-prefix denylist applied on every site_key. */
const GLOBAL_PROTECTED_PREFIXES = ["/api", "/_next", "/.well-known"];
/** Exact paths (+ subpaths) never redirected on any site. */
const GLOBAL_PROTECTED_EXACT = ["/login"];
/** Extra protected public-path prefixes for sensitive console areas (system host). */
const SITE_PROTECTED_PREFIXES: Partial<Record<SiteKey, string[]>> = {
  system: ["/security", "/keys", "/emergency", "/database", "/deployments", "/changes", "/approvals", "/integrations", "/jobs", "/kiosks", "/dev"],
};

const FILE_RE = /\.[a-zA-Z0-9]{1,10}$/;

function isProtectedPath(siteKey: SiteKey, path: string): boolean {
  const p = normalizePath(path);
  if (FILE_RE.test(p)) return true;
  for (const pre of GLOBAL_PROTECTED_PREFIXES) {
    if (p === pre || p.startsWith(`${pre}/`)) return true;
  }
  for (const ex of GLOBAL_PROTECTED_EXACT) {
    if (p === ex || p.startsWith(`${ex}/`)) return true;
  }
  for (const pre of SITE_PROTECTED_PREFIXES[siteKey] ?? []) {
    if (p === pre || p.startsWith(`${pre}/`)) return true;
  }
  return false;
}

/* ── Matching (pure — unit tested) ───────────────────────────────────────── */

/** Path-only normalization: strip query/hash, collapse a trailing slash ("/" stays "/"). */
export function normalizePath(p: string): string {
  let s = p.split("?")[0].split("#")[0];
  if (s.length > 1 && s.endsWith("/")) s = s.replace(/\/+$/, "");
  return s === "" ? "/" : s;
}

/** Index: site_key → Map<normalized from_path, validated to_path>. */
export type RedirectIndex = Map<string, Map<string, string>>;

export function buildRedirectIndex(rules: RedirectRule[]): RedirectIndex {
  const index: RedirectIndex = new Map();
  for (const r of rules) {
    if (typeof r.site_key !== "string" || typeof r.from_path !== "string") continue;
    const from = normalizePath(r.from_path);
    if (!isCleanRelativePath(from)) continue;
    const to = validateRedirectTarget(r.to_path);
    if (!to) continue; // invalid/external target — drop the rule entirely
    let site = index.get(r.site_key);
    if (!site) index.set(r.site_key, (site = new Map()));
    site.set(from, to); // unique(site_key, from_path) in schema; last write wins defensively
  }
  return index;
}

/** Single-step lookup: exact normalized path match for one site_key. */
function singleStep(index: RedirectIndex, siteKey: string, path: string): string | null {
  return index.get(siteKey)?.get(normalizePath(path)) ?? null;
}

/**
 * Resolves the final redirect target for a request path on a site, or null.
 * Follows relative to_path chains up to MAX_CHAIN_HOPS rule applications;
 * a cycle, an over-long chain, or a target equal to the request path → null
 * (the request proceeds normally — loops can never form).
 */
export function matchRedirect(index: RedirectIndex, siteKey: SiteKey, requestPath: string): string | null {
  if (isProtectedPath(siteKey, requestPath)) return null;
  const start = normalizePath(requestPath);
  let current = start;
  let final: string | null = null;
  let applications = 0;
  const seen = new Set<string>([current]);
  while (applications < MAX_CHAIN_HOPS) {
    const to = singleStep(index, siteKey, current);
    if (!to) break;
    applications += 1;
    if (to.startsWith("/")) {
      current = normalizePath(to);
      if (seen.has(current)) return null; // cycle
      seen.add(current);
      final = to;
    } else {
      final = to; // absolute https URL on an approved host — terminal
      break;
    }
  }
  if (applications === 0 || final === null) return null;
  // If we exhausted the hop budget and another rule still matches, the chain
  // is longer than allowed — skip rather than emit a partial redirect.
  if (applications >= MAX_CHAIN_HOPS && singleStep(index, siteKey, current)) return null;
  if (normalizePath(final) === start && final.startsWith("/")) return null; // self-redirect
  return final;
}

/* ── Cached loader ───────────────────────────────────────────────────────── */

let cache: { at: number; index: RedirectIndex } | null = null;

/** Test hook — clears the module-level rule cache. */
export function clearSiteRedirectCache(): void {
  cache = null;
}

async function loadIndex(): Promise<RedirectIndex | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return cache?.index ?? null;
  try {
    const res = await fetch(
      `${url}/rest/v1/site_redirects?select=site_key,from_path,to_path&enabled=eq.true&order=site_key.asc,from_path.asc&limit=${MAX_ROWS}`,
      {
        headers: { apikey: key, authorization: `Bearer ${key}`, accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: "no-store",
      },
    );
    if (!res.ok) return cache?.index ?? null;
    const rows = (await res.json()) as RedirectRule[];
    if (!Array.isArray(rows)) return cache?.index ?? null;
    const index = buildRedirectIndex(rows.slice(0, MAX_ROWS));
    cache = { at: Date.now(), index };
    return index;
  } catch {
    return cache?.index ?? null; // stale-forever fallback on backend failure
  }
}

/**
 * Public entry point for src/proxy.ts. Returns the final redirect target
 * (relative path or absolute approved-host URL) or null when no enabled rule
 * matches. Never throws — any failure resolves to "no redirect".
 */
export async function getRedirectFor(host: string, path: string): Promise<string | null> {
  try {
    const siteKey = siteKeyForHost(host, baseDomain());
    if (!siteKey) return null;
    if (isProtectedPath(siteKey, path)) return null; // cheap bail before any fetch
    const now = Date.now();
    let index = cache && now - cache.at < TTL_MS ? cache.index : null;
    if (!index) {
      index = await loadIndex();
      if (!index) return null;
    }
    return matchRedirect(index, siteKey, path);
  } catch {
    return null;
  }
}
