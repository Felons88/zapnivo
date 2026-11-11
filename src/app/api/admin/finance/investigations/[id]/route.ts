import { NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { fail, staffGate } from "@/lib/finance/http";
import { caseRiskSignals, getCase } from "@/lib/finance/investigations";

export const dynamic = "force-dynamic";

const UNCONFIGURED = { error: "Finance investigations aren't connected yet.", code: "backend_unconfigured" };
const idSchema = z.string().uuid();

/** GET /api/admin/finance/investigations/[id] — case + events + dossier + risk signals. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await staffGate(req, "fin-get", 240);
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return fail(404, "Case not found.");
  const db = serviceClient();
  if (!db) return NextResponse.json(UNCONFIGURED, { status: 503 });
  const res = await getCase(db, id);
  if (!res.ok) return fail(res.status, res.error);

  // Risk indicators are advisory — a failure here must never break the case view.
  let signals: Awaited<ReturnType<typeof caseRiskSignals>> = [];
  try { signals = await caseRiskSignals(db, res.data.case); } catch { signals = []; }

  return NextResponse.json({ case: res.data.case, events: res.data.events, risk_signals: signals });
}
