import type { NextRequest } from "next/server";
import { baseDomain } from "./subdomains";

const APP_SUBDOMAINS = new Set(["www", "support", "customer", "partners", "internal", "system", "api"]);

function configuredHost(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).host.toLowerCase();
  } catch { return null; }
}

/** The OAuth verifier cookie and callback must stay on the request host, after that host is trusted. */
export function authCallbackOrigin(req: NextRequest): string | null {
  const host = (req.headers.get("host") ?? req.nextUrl.host).toLowerCase();
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(host)) return null;
  const hostname = host.split(":")[0];
  const base = baseDomain();
  const productionHost = hostname === base || (hostname.endsWith(`.${base}`) && APP_SUBDOMAINS.has(hostname.slice(0, -(base.length + 1))));
  const configured = [process.env.NEXT_PUBLIC_SITE_URL, process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]
    .some((value) => configuredHost(value) === host);
  const local = process.env.NODE_ENV !== "production" && (hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost"));
  if (!productionHost && !configured && !local) return null;
  if (process.env.NODE_ENV === "production" && host.includes(":")) return null;
  return `${process.env.NODE_ENV === "production" ? "https:" : req.nextUrl.protocol}//${host}`;
}
