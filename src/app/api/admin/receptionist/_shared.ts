import { NextResponse } from "next/server";
import { getSessionUser, isStaff, type SessionUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";
import type { ReceptionistDb } from "@/lib/receptionist/service";

export type GuardOk = { ok: true; user: SessionUser; db: ReceptionistDb };
export type GuardFail = { ok: false; res: NextResponse };

/** Staff-only guard shared by every /api/admin/receptionist route. */
export async function receptionistGuard(opts: { write?: boolean } = {}): Promise<GuardOk | GuardFail> {
  const user = await getSessionUser();
  if (!user || !isStaff(user)) return { ok: false, res: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  const rl = rateLimit(`receptionist:${user.id}:${opts.write ? "w" : "r"}`, opts.write ? 30 : 120, 60_000);
  if (!rl.ok) return { ok: false, res: NextResponse.json({ error: "Rate limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }) };
  const db = serviceClient();
  if (!db) return { ok: false, res: NextResponse.json({ error: "Backend not configured" }, { status: 503 }) };
  return { ok: true, user, db };
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
