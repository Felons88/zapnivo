/**
 * Host-based routing for the Zapnivo subdomains. Pure functions so the whole
 * mapping is unit-testable — src/proxy.ts is a thin adapter over planRoute().
 *
 *   support.zapnivo.com  → /support   (customer help center, tickets, assistant)
 *   internal.zapnivo.com → /admin     (staff console)
 *   partners.zapnivo.com → /partners  (venue partner portal)
 *   api.zapnivo.com      → /api       (route handlers)
 *
 * On the apex domain the portal paths 308-redirect to their subdomain. On any
 * other host (localhost, *.vercel.app previews) paths keep working untouched;
 * *.localhost subdomains mirror the production scheme for local testing.
 */

export const SUB_PREFIX = { support: "/support", internal: "/admin", partners: "/partners" } as const;
export type Subdomain = keyof typeof SUB_PREFIX | "api";

export const DEFAULT_BASE_DOMAIN = "zapnivo.com";
/** Apex domain the subdomains hang off. Override with BASE_DOMAIN for staging setups. */
export const baseDomain = () => (process.env.BASE_DOMAIN ?? DEFAULT_BASE_DOMAIN).toLowerCase();

/**
 * Cookie domain that shares a session across every zapnivo.com subdomain; undefined
 * on any other host so the cookie stays host-only (localhost, previews).
 */
export const apexCookieDomain = (host: string) => {
  const h = host.split(":")[0].toLowerCase();
  const b = baseDomain();
  return h === b || h.endsWith(`.${b}`) ? b : undefined;
};

/** Top-level sections owned by the marketing site — on a subdomain these bounce to apex. */
const APEX_SECTIONS = new Set([
  "about", "advertise", "business", "contact", "how-it-works", "legal", "locations",
  "llms.txt", "llms-full.txt", "opengraph-image", "r", "account",
]);

export type RouteDecision =
  | { kind: "next"; noindex?: boolean }
  | { kind: "rewrite"; to: string; noindex?: boolean }
  | { kind: "redirect"; to: string } // absolute URL without query string
  | { kind: "respond"; status: number; body: string; contentType: string; noindex?: boolean };

export function planRoute({
  host,
  path,
  protocol,
  base = DEFAULT_BASE_DOMAIN,
  hasAuthCode = false,
}: {
  host: string;
  path: string;
  protocol: string; // "http:" | "https:" — from req.nextUrl.protocol
  base?: string;
  /** true when the URL carries an OAuth ?code= — Supabase drops it on the Site URL root when redirect_to isn't allowlisted */
  hasAuthCode?: boolean;
}): RouteDecision {
  const hostname = host.split(":")[0].toLowerCase();
  const port = host.includes(":") ? host.slice(host.indexOf(":")) : "";
  const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost");

  let sub: Subdomain | null = null;
  for (const s of ["support", "internal", "partners", "api"] as const) {
    if (hostname === `${s}.${base}` || (local && hostname === `${s}.localhost`)) { sub = s; break; }
  }

  const apexHost = local ? `localhost${port}` : base;
  const subHost = (s: Subdomain) => (local ? `${s}.localhost${port}` : `${s}.${base}`);
  const abs = (h: string, p: string) => `${protocol}//${h}${p}`;

  const first = path.split("/")[1] ?? "";
  const isFile = /\.[a-zA-Z0-9]{1,10}$/.test(path);
  const isApi = path === "/api" || path.startsWith("/api/");
  const pass = isApi || isFile || path === "/login" || path.startsWith("/.well-known/");

  // OAuth fallback: a ?code landing on / belongs to /api/auth/callback, on any host.
  if (hasAuthCode && (path === "/" || path === "")) return { kind: "rewrite", to: "/api/auth/callback" };

  if (sub === "api") {
    if (path === "/robots.txt") {
      return { kind: "respond", status: 200, body: "User-agent: *\nDisallow: /\n", contentType: "text/plain", noindex: true };
    }
    if (path === "/" || path === "") {
      return { kind: "respond", status: 200, body: JSON.stringify({ service: "zapnivo-api", ok: true }), contentType: "application/json", noindex: true };
    }
    // api.zapnivo.com/support/tickets → /api/support/tickets; /api/* passes through untouched
    return isApi ? { kind: "next", noindex: true } : { kind: "rewrite", to: `/api${path}`, noindex: true };
  }

  if (sub) {
    const prefix = SUB_PREFIX[sub];
    const noindex = sub !== "support";
    if (pass || path === prefix || path.startsWith(`${prefix}/`)) return { kind: "next", noindex };
    for (const [s, p] of Object.entries(SUB_PREFIX)) {
      // /admin/support/* is the staff helpdesk — on internal it stays internal
      if (sub === "internal" && s === "support") continue;
      if (s !== sub && (path === p || path.startsWith(`${p}/`))) {
        return { kind: "redirect", to: abs(subHost(s as Subdomain), path.slice(p.length) || "/") };
      }
    }
    if (APEX_SECTIONS.has(first)) return { kind: "redirect", to: abs(apexHost, path) };
    return { kind: "rewrite", to: path === "/" ? prefix : `${prefix}${path}`, noindex };
  }

  // apex production domain: portal paths canonicalize onto their subdomain
  if (hostname === base || hostname === `www.${base}`) {
    for (const [s, p] of Object.entries(SUB_PREFIX)) {
      if (path === p || path.startsWith(`${p}/`)) {
        return { kind: "redirect", to: abs(subHost(s as Subdomain), path.slice(p.length) || "/") };
      }
    }
  }
  return { kind: "next" };
}
