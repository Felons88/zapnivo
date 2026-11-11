import { NextResponse } from "next/server";
import { getThreadDetail } from "@/lib/receptionist/service";
import { receptionistGuard } from "../../_shared";

type Params = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Staff-only thread detail: messages + audit + pending draft. */
export async function GET(_req: Request, { params }: Params) {
  const g = await receptionistGuard();
  if (!g.ok) return g.res;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const detail = await getThreadDetail(g.db, id);
  if (!detail) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(detail);
}
