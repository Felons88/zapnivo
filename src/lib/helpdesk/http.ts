import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "../auth";
import { rateLimit } from "../rate-limit";
import { defaultCtx, type Ctx } from "./service";
import { HelpdeskError, type Actor } from "./types";

export const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

/** Same-origin check for state-changing requests (cookie-authenticated routes are SameSite=lax too). */
export function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  return !origin || new URL(origin).host === req.headers.get("host");
}

export const fail = (status: number, error: string, extra: object = {}) => NextResponse.json({ error, ...extra }, { status });

const STATUS: Record<HelpdeskError["code"], number> = { forbidden: 403, not_found: 404, invalid: 422, conflict: 409, unavailable: 503 };

/** Runs a helpdesk operation and maps domain errors to HTTP. Unexpected errors are logged without leaking details. */
export async function run(scope: string, fn: () => Promise<unknown>) {
  try { return NextResponse.json(await fn()); }
  catch (e) {
    if (e instanceof HelpdeskError) return fail(STATUS[e.code], e.message, { code: e.code });
    console.error(JSON.stringify({ level: "error", scope, msg: "unhandled", err: e instanceof Error ? e.message : "unknown" }));
    return fail(500, "Something went wrong. Please try again.");
  }
}

export async function needCtx(): Promise<Ctx | NextResponse> {
  const c = await defaultCtx();
  return c ?? fail(503, "The support system isn't available yet. Please email us instead.", { code: "backend_unconfigured" });
}

export async function staffActor(): Promise<Extract<Actor, { kind: "staff" }> | null> {
  const u = await getSessionUser();
  if (!u || !isStaff(u)) return null;
  return { kind: "staff", id: u.id, name: u.email.split("@")[0], role: u.role === "admin" ? "admin" : "staff" };
}

export async function partnerActor(): Promise<Extract<Actor, { kind: "partner" }> | null> {
  const u = await getSessionUser();
  if (!u || u.role !== "partner" || !u.organizationId) return null;
  return { kind: "partner", id: u.id, name: u.email.split("@")[0], email: u.email, orgId: u.organizationId };
}

export const limit = (key: string, n: number, windowMs: number) => rateLimit(key, n, windowMs);
