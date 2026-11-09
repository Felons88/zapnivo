import { NextResponse, type NextRequest } from "next/server";
import { baseDomain, planRoute } from "@/lib/subdomains";

/**
 * Host-based subdomain routing (see src/lib/subdomains.ts for the mapping).
 * Runs before filesystem routing; rewrites keep the public URL unchanged,
 * redirects canonicalize portal sections onto their subdomain.
 */
export function proxy(req: NextRequest) {
  const d = planRoute({
    host: req.headers.get("host") ?? "",
    path: req.nextUrl.pathname,
    protocol: req.nextUrl.protocol,
    base: baseDomain(),
  });
  const tag = (r: NextResponse, noindex?: boolean) => {
    if (noindex) r.headers.set("x-robots-tag", "noindex, nofollow");
    return r;
  };
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
