import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { transition } from "@/lib/experiments/service";
import type { ExperimentStatus } from "@/lib/experiments/core";
import { serviceClient } from "@/lib/supabase";

const schema = z.object({ to: z.enum(["draft", "approved", "running", "paused", "concluded"]) }).strict();

/** Staff: move an experiment through the state machine (approve / run / pause / conclude). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user || !isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const { id } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid transition." }, { status: 422 });

  const out = await transition(db, id, parsed.data.to as ExperimentStatus, user.id);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 422 });
  await auditLog(user.id, `experiment_${parsed.data.to}`, "experiment", id, { to: parsed.data.to });
  return NextResponse.json({ ok: true });
}
