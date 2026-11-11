import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { createGroup, listGroups, listMemberGroups } from "@/lib/groups";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  max_members: z.number().int().min(1).max(50).optional(),
}).strict();

const ip = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";

/** Organizer: list own rental groups. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  return NextResponse.json({ groups: await listGroups(db, user.id), memberships: await listMemberGroups(db, user.id) });
}

/** Organizer: create a rental group. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  if (!rateLimit(`groups:create:${user.id}`, 10, 60_000).ok) return NextResponse.json({ error: "Too many requests." }, { status: 429 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid group.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });
  const out = await createGroup(db, user.id, { name: parsed.data.name, maxMembers: parsed.data.max_members });
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ group: out.data }, { status: 201 });
}
