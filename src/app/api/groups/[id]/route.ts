import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getGroup, updateGroup } from "@/lib/groups";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  max_members: z.number().int().min(1).max(50).optional(),
}).strict();

/** Organizer: group detail with members + counts. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  const { id } = await params;
  const out = await getGroup(db, user.id, id);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json(out.data);
}

/** Organizer: update name / max_members. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  if (!rateLimit(`groups:update:${user.id}`, 30, 60_000).ok) return NextResponse.json({ error: "Too many attempts." }, { status: 429 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid update.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });
  const out = await updateGroup(db, user.id, id, { name: parsed.data.name, maxMembers: parsed.data.max_members });
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ group: out.data });
}
