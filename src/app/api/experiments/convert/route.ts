import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { hashSubject } from "@/lib/experiments/core";
import { getExperiment, recordConversion } from "@/lib/experiments/service";
import { newVisitorId, readVisitorId, setVisitorCookie } from "@/lib/experiments/visitor";
import { rateLimit } from "@/lib/rate-limit";
import { recordLog } from "@/lib/observability";
import { serviceClient } from "@/lib/supabase";

const ip = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

const schema = z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/) }).strict();

/**
 * Records a conversion for the caller's existing assignment. Works even after an
 * experiment leaves 'running' (a visitor exposed earlier may convert later), but
 * only if an assignment row actually exists — no row, no conversion.
 * Response contract: 200 { ok: true } always on success; {} never needed — callers
 * can ignore failures. 422 invalid · 429 rate limited · 503 unconfigured.
 */
export async function POST(req: NextRequest) {
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Experiments unavailable." }, { status: 503 });
  if (!rateLimit(`exp-convert:${ip(req)}`, 60, 60_000).ok) return NextResponse.json({ error: "Too many requests." }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 422 });
  const { key } = parsed.data;

  let vid = readVisitorId(req);
  const isNew = !vid;
  if (!vid) vid = newVisitorId();

  try {
    const exp = await getExperiment(db, key);
    if (exp) {
      const subjectHash = hashSubject(`${vid}:${key}`);
      await recordConversion(db, exp.id, subjectHash);
    }
    const res = NextResponse.json({ ok: true });
    if (isNew) setVisitorCookie(res, req, vid);
    return res;
  } catch (e) {
    recordLog("warning", "experiment convert failed", { route: "/api/experiments/convert", attrs: { key } });
    void e;
    const res = NextResponse.json({ ok: true }); // fail-open: conversions must never break UX
    if (isNew) setVisitorCookie(res, req, vid);
    return res;
  }
}
