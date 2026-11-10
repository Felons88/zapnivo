import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

const schema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{24}$/),
  status: z.enum(["new", "investigating", "assigned", "resolved", "ignored"]),
}).strict();

/** Staff-only issue workflow: resolve / ignore / reopen / mark investigating. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 422 });

  const { fingerprint, status } = parsed.data;
  const patch: Record<string, unknown> = { status };
  if (status === "resolved") patch.resolved_at = new Date().toISOString();
  if (status === "assigned" && user) patch.assigned_to = user.id;
  if (status === "new" || status === "investigating") patch.resolved_at = null;

  const { data, error } = await db.from("error_issues").update(patch).eq("fingerprint", fingerprint).select("id").maybeSingle();
  if (error) return NextResponse.json({ error: "Update failed." }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Issue not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
