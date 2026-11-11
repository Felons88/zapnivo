import { NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { fail, staffGate } from "@/lib/finance/http";
import { recommend } from "@/lib/finance/investigations";

export const dynamic = "force-dynamic";
const UNCONFIGURED = { error: "Finance investigations aren't connected yet.", code: "backend_unconfigured" };

/**
 * POST /api/admin/finance/investigations/[id]/recommend — re-run the rule engine.
 * Advisory only: stores a recommendation, NEVER approves or moves money.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await staffGate(req, "fin-recommend", 60);
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return fail(404, "Case not found.");
  const db = serviceClient();
  if (!db) return NextResponse.json(UNCONFIGURED, { status: 503 });
  const res = await recommend(db, id, gate.id);
  if (!res.ok) return fail(res.status, res.error);
  return NextResponse.json({ case: res.data.case, recommendation: res.data.recommendation });
}
