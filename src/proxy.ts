import { NextResponse, type NextRequest } from "next/server";
import { baseDomain, planRoute } from "@/lib/subdomains";
import { getRedirectFor } from "@/lib/site-redirects";

/**
 * Host-based subdomain routing (see src/lib/subdomains.ts for the mapping)
 * plus DB-driven path redirects (site_redirects via src/lib/site-redirects.ts).
 * Runs before filesystem routing; rewrites keep the public URL unchanged,
 * redirects canonicalize portal sections onto their subdomain.
 *
 * Redirect rules match the PUBLIC path on the request host (from_path
 * semantics), so they are evaluated on req.nextUrl.pathname BEFORE any
 * subdomain rewrite — e.g. a rule from_path='/old' on site_key 'support'
 * fires for support.zapnivo.com/old even though it would internally rewrite
 * to /support/old. Rules only apply when planRoute lets the request proceed
 * ('next'/'rewrite'); canonicalization redirects and 'respond' replies win.
 * All rule redirects are 307 (temporary) — see site-redirects.ts.
 */
export async function proxy(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  const pathname = req.nextUrl.pathname;
  const d = planRoute({
    host,
    path: pathname,
    protocol: req.nextUrl.protocol,
    base: baseDomain(),
    hasAuthCode: req.nextUrl.searchParams.has("code"),
  });
  const tag = (r: NextResponse, noindex?: boolean) => {
    if (noindex) r.headers.set("x-robots-tag", "noindex, nofollow");
    return r;
  };

  // Operator-managed redirects (site_redirects). Only for requests that would
  // otherwise proceed; the lookup is cached ~60s and fails open (null).
  if (d.kind === "next" || d.kind === "rewrite") {
    const target = await getRedirectFor(host, pathname);
    if (target) {
      const url = target.startsWith("/") ? new URL(target, req.url) : new URL(target);
      if (!url.search && req.nextUrl.search) url.search = req.nextUrl.search;
      return NextResponse.redirect(url, 307);
    }
  }

  switch (d.kind) {
    case "redirect":
      return NextResponse.redirect(`${d.to}${req.nextUrl.search}`, 308);
    case "rewrite": {
      const url = req.nextUrl.clone();
      url.pathname = d.to;
      return tag(NextResponse.rewrite(url), d.noindex);
    }
    case "respond":
      return tag(new NextResponse(d.body, { status: d.status, headers: { "content-type": d.contentType } }), d.noindex);
    default:
      return tag(NextResponse.next(), d.noindex);
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
