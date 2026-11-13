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
 *    Proxy/admin writes cannot bust this cache cross-instance, so a new/edited
 *    redirect can take up to ~60s to take effect — acceptable for
 *    operator-managed rules. Disabling a harmful rule (enabled=false or
 *    delete) propagates on the next successful fetch, i.e. ≤ ~60s + fetch.
 *  - STALE CACHE LIMIT: on fetch failure the last good cache is served only
 *    while it is younger than MAX_STALE_MS (10 min). Past that we serve NO
 *    redirects — a safety-critical disable must never be masked indefinitely
 *    by a stale snapshot (fail closed).
 *  - KILL SWITCH: env SITE_REDIRECTS_DISABLED=1 (or "true") disables ALL
 *    redirects instantly on every instance that restarts/picks up env —
 *    checked FIRST, before the cache, on every call. Use for incidents.
 *  - Console/API hosts (site_key 'system' and 'api') NEVER redirect: they are
 *    not content sites and a rule could break the ops console, auth flows, or
 *    API routing. 'internal' (staff console) stays enabled but /admin and the
 *    global auth prefixes are protected — see isProtectedPath.
 *  - Path normalization is applied IDENTICALLY to stored from_path values and
 *    request paths: bounded iterative percent-decoding (≤3 rounds, so %2F,
 *    %252F, %5C collapse to one canonical form), backslash→slash, duplicate
 *    slash collapse, trailing-slash strip, query/hash strip. This makes
 *    encoded/double-encoded slash tricks unable to bypass protected-path
 *    checks or create match mismatches regardless of whether Next.js hands
 *    us a raw or pre-decoded pathname.
 *  - Matching itself stays CASE-SENSITIVE (URL semantics); only the
 *    protected-path check lowercases, so /API/x, /Login etc. can never be
 *    redirected even though they wouldn't match a lowercase rule anyway.
 *  - to_path query strings ARE allowed and preserved (a stored '?x=1' wins;
 *    otherwise the request query is carried over — see proxy.ts). A '?next='
 *    param inside to_path is just data for the destination page; it cannot
 *    turn into an open redirect here because to_path itself is pinned to a
 *    validated relative path or approved-host https URL.
 *  - Status code: the schema has no permanent/temporary column, so ALL
 *    redirects are issued as 307 (temporary) — never cached by browsers/CDNs
 *    as permanent. Revisit if a `permanent` flag is ever added (migration).
 *  - Redirect hits are NOT audited per-request (high volume, would be noise);
 *    admin CRUD is already audited in site-ops.ts. Cross-host loop prevention
 *    below adds one cached lookup per absolute-target match.
 */

export type RedirectRule = { site_key: string; from_path: string; to_path: string };

const TTL_MS = 60_000;
/** Serve stale cache on backend failure only while younger than this. */
const MAX_STALE_MS = 10 * 60_000;
const MAX_ROWS = 500;
const FETCH_TIMEOUT_MS = 2_500;
/** Total rule applications allowed while resolving a chain (1 = no chaining). */
const MAX_CHAIN_HOPS = 2;
/** Bounded decode rounds: handles %2F, %252F and one level beyond; deeper
 *  nesting stays encoded and simply can't match or bypass anything. */
const MAX_DECODE_ROUNDS = 3;

/** Env kill switch — checked on EVERY call, before the cache. */
function redirectsDisabled(): boolean {
  const v = process.env.SITE_REDIRECTS_DISABLED;
  return v === "1" || v === "true";
}

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
    !v.includes("\\") && // backslash is normalized to '/' before matching; never valid stored
    !/\s/.test(v) &&
    !v.includes("://") &&
    !v.includes("..") &&
    FROM_PATH_RE.test(v)
  );
}

/**
 * Read-side re-validation of to_path (defense in depth — write path already
 * validates, but rows could be inserted out-of-band). Accepts a relative path
 * or an absolute https URL on an approved Zapnivo/localhost host. Rejects ALL
 * non-http(s) schemes, protocol-relative (//host, \\host), credential-bearing
 * URLs, and anything malformed. Anything else → null (rule dropped).
 */
export function validateRedirectTarget(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 2000) return null;
  // Protocol-relative and backslash-leading forms can never be a safe target.
  if (s.startsWith("//") || s.startsWith("\\") || s.startsWith("/\\")) return null;
  if (s.startsWith("/")) return isCleanRelativePath(s) ? s : null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
  if (url.protocol === "http:" && !local) return null; // http only for localhost dev
  if (url.username || url.password) return null; // no credential-bearing redirects
  if (!isAllowedTargetHost(url.hostname)) return null;
  return url.toString();
}

/* ── Protected paths — never redirected regardless of DB rows ────────────── */

/** Segment-prefix denylist applied on every site_key (lowercased compare). */
const GLOBAL_PROTECTED_PREFIXES = ["/api", "/_next", "/.well-known", "/auth"];
/** Exact paths (+ subpaths) never redirected on any site. */
const GLOBAL_PROTECTED_EXACT = ["/login"];
/**
 * Per-site extra protected prefixes. 'system' and 'api' are disabled entirely
 * (see REDIRECT_DISABLED_SITES); 'internal' protects the staff-console prefix
 * itself plus security/admin surfaces — on that host public paths rewrite
 * into /admin/*, so a stray rule could otherwise shadow console routes.
 */
const SITE_PROTECTED_PREFIXES: Partial<Record<SiteKey, string[]>> = {
  system: ["/security", "/keys", "/emergency", "/database", "/deployments", "/changes", "/approvals", "/integrations", "/jobs", "/kiosks", "/dev"],
  internal: ["/admin", "/system", "/security", "/mfa", "/emergency"],
};

/** site_keys where redirects are disabled entirely — non-content console/API hosts. */
const REDIRECT_DISABLED_SITES = new Set<SiteKey>(["system", "api"]);

const FILE_RE = /\.[a-z0-9]{1,10}$/;

/** True when the normalized path contains a '..' segment (encoded tricks like
 *  %2e%2e decode into this — such requests are never redirected). */
function hasDotDotSegment(p: string): boolean {
  return p.split("/").includes("..");
}

function isProtectedPath(siteKey: SiteKey, path: string): boolean {
  const p = normalizePath(path);
  if (hasDotDotSegment(p)) return true; // traversal-shaped — fail closed
  const lower = p.toLowerCase(); // protected check is case-insensitive on purpose
  if (FILE_RE.test(lower)) return true;
  for (const pre of GLOBAL_PROTECTED_PREFIXES) {
    if (lower === pre || lower.startsWith(`${pre}/`)) return true;
  }
  for (const ex of GLOBAL_PROTECTED_EXACT) {
    if (lower === ex || lower.startsWith(`${ex}/`)) return true;
  }
  for (const pre of SITE_PROTECTED_PREFIXES[siteKey] ?? []) {
    const lpre = pre.toLowerCase();
    if (lower === lpre || lower.startsWith(`${lpre}/`)) return true;
  }
  return false;
}

/* ── Matching (pure — unit tested) ───────────────────────────────────────── */

/** Bounded iterative percent-decode. Malformed '%' sequences keep the last
 *  good value; anything still encoded after MAX_DECODE_ROUNDS stays literal. */
function decodePath(s: string): string {
  let out = s;
  for (let i = 0; i < MAX_DECODE_ROUNDS && out.includes("%"); i++) {
    try {
      const d = decodeURIComponent(out);
      if (d === out) break;
      out = d;
    } catch {
      break;
    }
  }
  return out;
}

/**
 * Canonical path form used for BOTH stored from_path values and request paths:
 *  1. bounded percent-decode (%2F, %252F, %5C, %2e%2e all collapse)
 *  2. strip query/hash
 *  3. backslash → '/' (a '\' can never smuggle a path boundary)
 *  4. collapse duplicate slashes ('//login' → '/login')
 *  5. strip trailing slash(es) ('/login/' → '/login'; '/' stays '/')
 * Matching stays case-sensitive; protection lowercases separately.
 */
export function normalizePath(p: string): string {
  let s = decodePath(p);
  s = s.split("?")[0].split("#")[0];
  s = s.replace(/\\/g, "/");
  s = s.replace(/\/{2,}/g, "/");
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
    if (!isCleanRelativePath(from)) continue; // encoded/unclean stored paths drop out
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
  if (REDIRECT_DISABLED_SITES.has(siteKey)) return null;
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

/** Stale cache is only trustworthy for MAX_STALE_MS — after that, no redirects. */
function usableStale(): RedirectIndex | null {
  return cache && Date.now() - cache.at <= MAX_STALE_MS ? cache.index : null;
}

async function loadIndex(): Promise<RedirectIndex | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return usableStale();
  try {
    const res = await fetch(
      `${url}/rest/v1/site_redirects?select=site_key,from_path,to_path&enabled=eq.true&order=site_key.asc,from_path.asc&limit=${MAX_ROWS}`,
      {
        headers: { apikey: key, authorization: `Bearer ${key}`, accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: "no-store",
      },
    );
    if (!res.ok) return usableStale();
    const rows = (await res.json()) as RedirectRule[];
    if (!Array.isArray(rows)) return usableStale();
    const index = buildRedirectIndex(rows.slice(0, MAX_ROWS));
    cache = { at: Date.now(), index };
    return index;
  } catch {
    return usableStale(); // bounded stale fallback on backend failure
  }
}

/**
 * Public entry point for src/proxy.ts. Returns the final redirect target
 * (relative path or absolute approved-host URL) or null when no enabled rule
 * matches. Never throws — any failure resolves to "no redirect" (fail closed).
 *
 * host comes from the request Host header (set by the platform — Vercel — not
 * from client-controlled x-forwarded-host, which is never consulted here).
 * Unknown/unmappable hosts → siteKeyForHost null → no redirects.
 */
export async function getRedirectFor(host: string, path: string): Promise<string | null> {
  try {
    if (redirectsDisabled()) return null; // kill switch first — before cache
    const siteKey = siteKeyForHost(host, baseDomain());
    if (!siteKey) return null;
    if (REDIRECT_DISABLED_SITES.has(siteKey)) return null; // console/API hosts never redirect
    if (isProtectedPath(siteKey, path)) return null; // cheap bail before any fetch
    const now = Date.now();
    let index = cache && now - cache.at < TTL_MS ? cache.index : null;
    if (!index) {
      index = await loadIndex();
      if (!index) return null;
    }
    const target = matchRedirect(index, siteKey, path);
    if (!target) return null;
    if (target.startsWith("/")) return target;
    // Absolute approved-host target: skip if the DESTINATION host also has a
    // matching rule — prevents cross-host ping-pong loops that the per-site
    // chain limit cannot see (one extra cached lookup; fail closed on parse).
    try {
      const dest = new URL(target);
      const destKey = siteKeyForHost(dest.hostname, baseDomain());
      if (destKey && !REDIRECT_DISABLED_SITES.has(destKey) && singleStep(index, destKey, dest.pathname)) {
        return null;
      }
    } catch {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}
