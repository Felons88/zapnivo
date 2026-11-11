import { NextResponse } from "next/server";
import { z } from "zod";
import { systemApiGuard, readJson } from "../../../_shared";
import { decideChange } from "@/lib/system/audit";

const decisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().max(2000).optional(),
});

/**
 * POST /api/system/changes/[id]/decision — approve or reject a pending change
 * request (system.changes.decide). Separation of duties: the requester can never
 * decide their own request (enforced in decideChange AND here as defense in depth).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await systemApiGuard("system.changes.decide", { limit: 30 });
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const body = await readJson(req);
  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  const result = await decideChange(g.db, { id: g.user.id, role: g.role }, id, parsed.data.decision, parsed.data.note);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ change: result.row });
}
