import { NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { fail, readJson, staffGate } from "@/lib/finance/http";
import { assignCase } from "@/lib/finance/investigations";

export const dynamic = "force-dynamic";
const UNCONFIGURED = { error: "Finance investigations aren't connected yet.", code: "backend_unconfigured" };

const schema = z.object({ assigned_to: z.string().uuid().nullable() });

/** POST /api/admin/finance/investigations/[id]/assign — assign (or unassign with null) a staff member. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await staffGate(req, "fin-assign", 60);
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return fail(404, "Case not found.");
  const db = serviceClient();
  if (!db) return NextResponse.json(UNCONFIGURED, { status: 503 });
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) return fail(422, "assigned_to must be a staff profile id or null.");
  const res = await assignCase(db, id, gate.id, parsed.data.assigned_to);
  if (!res.ok) return fail(res.status, res.error);
  return NextResponse.json({ case: res.data.case });
}
