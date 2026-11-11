import { NextResponse } from "next/server";
import { assignThread } from "@/lib/receptionist/service";
import { readJson, receptionistGuard } from "../../../_shared";

type Params = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Assign a thread to a staff member. */
export async function POST(req: Request, { params }: Params) {
  const g = await receptionistGuard({ write: true });
  if (!g.ok) return g.res;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJson(req);
  const staffId = typeof body?.staffId === "string" ? body.staffId : "";
  if (!UUID.test(staffId)) return NextResponse.json({ error: "invalid_assignee" }, { status: 422 });
  const r = await assignThread(g.db, id, staffId, g.user.email || g.user.id);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status ?? 500 });
  return NextResponse.json({ ok: true });
}
