import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { hashSubject } from "@/lib/experiments/core";
import { assign, recordExposure } from "@/lib/experiments/service";
import { newVisitorId, readVisitorId, setVisitorCookie } from "@/lib/experiments/visitor";
import { rateLimit } from "@/lib/rate-limit";
import { recordLog } from "@/lib/observability";
import { serviceClient } from "@/lib/supabase";

const ip = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

const schema = z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/) }).strict();

/**
 * Public experiment assignment. Returns {} when the experiment isn't active —
 * callers must treat "no variant" as "render control/default". Fail-open: any
 * backend problem yields {} so experiments can never break the site.
 *
 * Response contract:
 *   200 { variant: { key: string, config: object } }   — assigned (exposure recorded)
 *   200 {}                                              — no active experiment / no assignment
 *   422 invalid body · 429 rate limited · (503 only when Supabase unconfigured)
 */
export async function POST(req: NextRequest) {
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Experiments unavailable." }, { status: 503 });
  if (!rateLimit(`exp-assign:${ip(req)}`, 60, 60_000).ok) return NextResponse.json({ error: "Too many requests." }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 422 });
  const { key } = parsed.data;

  // Visitor id: reuse the zn_vid cookie or mint one (Set-Cookie on the response).
  let vid = readVisitorId(req);
  const isNew = !vid;
  if (!vid) vid = newVisitorId();

  // Per-experiment salt: vid + ':' + key keeps buckets uncorrelated across experiments.
  const subjectHash = hashSubject(`${vid}:${key}`);

  try {
    const assignment = await assign(db, key, subjectHash);
    if (!assignment) {
      const res = NextResponse.json({});
      if (isNew) setVisitorCookie(res, req, vid);
      return res;
    }
    await recordExposure(db, assignment.experiment_id, subjectHash);
    const res = NextResponse.json({ variant: { key: assignment.variant_key, config: assignment.config } });
    if (isNew) setVisitorCookie(res, req, vid);
    return res;
  } catch (e) {
    recordLog("warning", "experiment assign failed", { route: "/api/experiments/assign", attrs: { key } });
    void e;
    const res = NextResponse.json({});
    if (isNew) setVisitorCookie(res, req, vid);
    return res;
  }
}
