import { NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { fail, readJson, staffGate } from "@/lib/finance/http";
import { decideCase } from "@/lib/finance/investigations";

export const dynamic = "force-dynamic";
const UNCONFIGURED = { error: "Finance investigations aren't connected yet.", code: "backend_unconfigured" };

const schema = z.object({
  decision: z.enum(["approved", "denied"]),
  rationale: z.string().trim().min(5).max(2000),
});

/**
 * POST /api/admin/finance/investigations/[id]/decide — HUMAN decision only.
 * Staff session required, rationale mandatory, every decision audited.
 * This route NEVER executes a refund — an "approved" case only means staff may now
 * use the existing staff refund route (src/app/api/admin/payments/[id]/refund).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await staffGate(req, "fin-decide", 30);
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return fail(404, "Case not found.");
  const db = serviceClient();
  if (!db) return NextResponse.json(UNCONFIGURED, { status: 503 });
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) return fail(422, "Decision must be 'approved' or 'denied' with a rationale of at least 5 characters.");
  const res = await decideCase(db, id, { id: gate.id, role: gate.role === "admin" ? "admin" : "staff" }, parsed.data.decision, parsed.data.rationale);
  if (!res.ok) return fail(res.status, res.error);
  return NextResponse.json({ case: res.data.case, events: res.data.events });
}
