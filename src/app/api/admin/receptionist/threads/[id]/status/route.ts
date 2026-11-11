import { NextResponse } from "next/server";
import { transitionThread } from "@/lib/receptionist/service";
import { RECEPTIONIST_STATUSES, type ReceptionistStatus } from "@/lib/receptionist/types";
import { readJson, receptionistGuard } from "../../../_shared";

type Params = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Staff status transition — validated against STAFF_TRANSITIONS. */
export async function POST(req: Request, { params }: Params) {
  const g = await receptionistGuard({ write: true });
  if (!g.ok) return g.res;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJson(req);
  const to = typeof body?.status === "string" ? body.status : "";
  if (!(RECEPTIONIST_STATUSES as readonly string[]).includes(to)) {
    return NextResponse.json({ error: "invalid_status" }, { status: 422 });
  }
  const r = await transitionThread(g.db, id, to as ReceptionistStatus, g.user.email || g.user.id);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status ?? 500 });
  return NextResponse.json({ ok: true });
}
