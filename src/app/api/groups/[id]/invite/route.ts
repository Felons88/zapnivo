import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { inviteMember } from "@/lib/groups";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";

const schema = z.object({ email: z.string().trim().toLowerCase().email().max(200) }).strict();

/** Organizer: invite an email. Returns the join URL + raw token ONCE — only the hash is stored. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  const { id } = await params;
  if (!rateLimit(`groups:invite:${user.id}`, 30, 60_000).ok) return NextResponse.json({ error: "Too many invites." }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid email address.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });
  const out = await inviteMember(db, user.id, id, parsed.data.email);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({ member: out.data.member, invite_url: out.data.url, token: out.data.token }, { status: 201 });
}
