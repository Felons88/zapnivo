import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { issuePass, listPasses } from "@/lib/events-program";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";

const issueSchema = z.object({
  units: z.number().int().min(1).max(100),
  expires_at: z.string().trim().max(60).nullable().optional(),
}).strict();

/** Organizer: list passes for an event (no codes — hashes never leave the server). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  const { id } = await params;
  const out = await listPasses(db, user.id, id);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ passes: out.data });
}

/** Organizer: issue a pass — returns the raw code ONCE. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  const { id } = await params;
  if (!rateLimit(`events:issue:${user.id}`, 60, 60_000).ok) return NextResponse.json({ error: "Too many requests." }, { status: 429 });

  const parsed = issueSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid pass.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });
  const out = await issuePass(db, user.id, id, { units: parsed.data.units, expiresAt: parsed.data.expires_at ?? null });
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ pass: out.data.pass, code: out.data.code }, { status: 201 });
}
