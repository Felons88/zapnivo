import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { apexCookieDomain } from "../subdomains";

/**
 * Anonymous visitor id for experiment bucketing. NOT httpOnly — client-side
 * experiment code may need to read it — but it carries no PII (random uuid) and
 * is only ever stored server-side as a hash.
 */
export const VISITOR_COOKIE = "zn_vid";
const ONE_YEAR_S = 60 * 60 * 24 * 365;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const newVisitorId = () => randomUUID();

/** Returns the existing visitor id, or null when the cookie is absent/invalid. */
export function readVisitorId(req: NextRequest): string | null {
  const v = req.cookies.get(VISITOR_COOKIE)?.value;
  return v && UUID_RE.test(v) ? v : null;
}

/** Sets the visitor cookie on a response. Domain mirrors apexCookieDomain so it spans subdomains in prod. */
export function setVisitorCookie(res: NextResponse, req: NextRequest, vid: string) {
  res.cookies.set(VISITOR_COOKIE, vid, {
    httpOnly: false,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/",
    maxAge: ONE_YEAR_S,
    domain: apexCookieDomain(req.headers.get("host") ?? ""),
  });
}
