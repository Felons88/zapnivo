import { NextResponse } from "next/server";
import { z } from "zod";
import { decideApproval } from "@/lib/agents/registry";
import { recordLog } from "@/lib/observability";
import { aiGuard, readJson } from "../../_shared";

const schema = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(500).optional(),
});

const UUID = /^[0-9a-f-]{36}$/i;

/** Staff approve/reject on a pending agent approval. Denied actions can't be approved. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await aiGuard();
  if (!g.ok) return g.res;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid approval id" }, { status: 400 });
  const body = await readJson(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "decision must be approved|rejected" }, { status: 422 });

  const out = await decideApproval(g.db, id, g.user.id, parsed.data.decision === "approved", parsed.data.note ?? null);
  if (!out.ok) {
    const status = out.error === "not_found" ? 404 : out.error === "already_decided" ? 409 : 403;
    return NextResponse.json({ error: out.error }, { status });
  }
  recordLog("info", `AI approval ${id} ${parsed.data.decision}`, {
    service: "ai-ops", route: "/api/admin/ai/approvals",
    attrs: { approval: id, decision: parsed.data.decision, actor: g.user.id },
  });
  return NextResponse.json({ ok: true });
}
