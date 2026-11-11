import { NextResponse } from "next/server";
import { addInternalNote } from "@/lib/receptionist/service";
import { readJson, receptionistGuard } from "../../../_shared";

type Params = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Internal note — stored on the thread, never emailed. */
export async function POST(req: Request, { params }: Params) {
  const g = await receptionistGuard({ write: true });
  if (!g.ok) return g.res;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJson(req);
  const text = typeof body?.body === "string" ? body.body : "";
  const r = await addInternalNote(g.db, id, { id: g.user.id, email: g.user.email }, text);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status ?? 500 });
  return NextResponse.json({ ok: true });
}
