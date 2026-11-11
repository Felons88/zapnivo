import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser } from "@/lib/auth";
import { adjustGroupCredit } from "@/lib/groups";
import { serviceClient } from "@/lib/supabase";

const schema = z.object({
  cents: z.number().int().min(-10_000_000).max(10_000_000).refine((v) => v !== 0, "cents must be non-zero"),
  note: z.string().trim().max(300).optional(),
}).strict();

/**
 * Staff/admin: adjust a group's shared credit pool (signed delta, cents).
 * Self-serve funding is pending — this is the only funding path for now.
 * Every adjustment is written to audit_logs AND entitlement_events.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (user?.role !== "admin") return NextResponse.json({ error: "Admins only." }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured." }, { status: 503 });
  const { id } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid adjustment.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });

  const out = await adjustGroupCredit(db, id, parsed.data.cents, user!.id, parsed.data.note);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  await auditLog(user!.id, "group_credit_adjust", "rental_group", id, { delta_cents: parsed.data.cents, note: parsed.data.note ?? null, new_balance: out.data.credit_cents });
  return NextResponse.json({ group: out.data });
}
