import { NextResponse } from "next/server";
import { getSessionUser, isStaff, type SessionUser } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";
import type { AgentsDb } from "@/lib/agents/registry";

export type GuardOk = { ok: true; user: SessionUser; db: AgentsDb };
export type GuardFail = { ok: false; res: NextResponse };

/** Staff-only JSON guard shared by every /api/admin/ai route. */
export async function aiGuard(): Promise<GuardOk | GuardFail> {
  const user = await getSessionUser();
  if (!user || !isStaff(user)) return { ok: false, res: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  const db = serviceClient();
  if (!db) return { ok: false, res: NextResponse.json({ error: "Backend not configured" }, { status: 503 }) };
  return { ok: true, user, db };
}

export const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
