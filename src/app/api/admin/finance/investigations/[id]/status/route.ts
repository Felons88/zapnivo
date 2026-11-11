import { NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { fail, readJson, staffGate } from "@/lib/finance/http";
import { addCaseNote, FIN_CASE_STATUSES, setCaseStatus } from "@/lib/finance/investigations";

export const dynamic = "force-dynamic";
const UNCONFIGURED = { error: "Finance investigations aren't connected yet.", code: "backend_unconfigured" };

const schema = z.union([
  z.object({ op: z.literal("status"), status: z.enum(FIN_CASE_STATUSES) }),
  z.object({ op: z.literal("note"), note: z.string().trim().min(1).max(2000) }),
]);

/** POST /api/admin/finance/investigations/[id]/status — status transition or internal note. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await staffGate(req, "fin-status", 60);
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return fail(404, "Case not found.");
  const db = serviceClient();
  if (!db) return NextResponse.json(UNCONFIGURED, { status: 503 });
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) return fail(422, "Expected {op:'status',status} or {op:'note',note}.");
  const res = parsed.data.op === "status"
    ? await setCaseStatus(db, id, gate.id, parsed.data.status)
    : await addCaseNote(db, id, gate.id, parsed.data.note);
  if (!res.ok) return fail(res.status, res.error);
  return NextResponse.json({ case: res.data.case, events: res.data.events });
}
