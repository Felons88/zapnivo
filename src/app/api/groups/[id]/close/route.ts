import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { closeGroup } from "@/lib/groups";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";

/** Organizer: close a group (terminal — roster becomes read-only). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  if (!rateLimit(`groups:close:${user.id}`, 20, 60_000).ok) return NextResponse.json({ error: "Too many attempts." }, { status: 429 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  const { id } = await params;
  const out = await closeGroup(db, user.id, id);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ ok: true });
}
