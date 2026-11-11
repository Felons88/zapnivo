import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { transitionEvent, type EventStatus } from "@/lib/events-program";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";

const schema = z.object({
  to: z.enum(["draft", "active", "paused", "closed", "cancelled"]),
}).strict();

/** Organizer: move an event through its lifecycle (draft→active→paused→closed/cancelled). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  const { id } = await params;
  if (!rateLimit(`events:transition:${user.id}`, 30, 60_000).ok) return NextResponse.json({ error: "Too many requests." }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid transition." }, { status: 422 });
  const out = await transitionEvent(db, user.id, id, parsed.data.to as EventStatus);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ event: out.data });
}
