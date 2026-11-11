import { NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { fail, staffGate } from "@/lib/finance/http";
import { collectEvidence } from "@/lib/finance/investigations";

export const dynamic = "force-dynamic";
const UNCONFIGURED = { error: "Finance investigations aren't connected yet.", code: "backend_unconfigured" };

/** POST /api/admin/finance/investigations/[id]/collect — (re)build the evidence dossier. Idempotent. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await staffGate(req, "fin-collect", 60);
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return fail(404, "Case not found.");
  const db = serviceClient();
  if (!db) return NextResponse.json(UNCONFIGURED, { status: 503 });
  const res = await collectEvidence(db, id);
  if (!res.ok) return fail(res.status, res.error);
  return NextResponse.json({ case: res.data.case, dossier: res.data.dossier });
}
