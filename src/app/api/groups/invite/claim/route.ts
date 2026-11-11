import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { claimInvite } from "@/lib/groups";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";

const schema = z.object({ token: z.string().trim().min(10).max(200) }).strict();

/** Signed-in user claims a group invite token (sha256 lookup, claim-once). */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required to join a group." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  if (!rateLimit(`groups:claim:${user.id}`, 20, 60_000).ok) return NextResponse.json({ error: "Too many attempts." }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid invite." }, { status: 422 });
  const out = await claimInvite(db, user.id, parsed.data.token);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ ok: true, group: out.data });
}
