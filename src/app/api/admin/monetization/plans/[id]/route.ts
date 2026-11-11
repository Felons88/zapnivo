import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isStaff } from "@/lib/auth";
import { recordLog } from "@/lib/observability";
import { serviceClient } from "@/lib/supabase";

const patchSchema = z.object({
  active: z.boolean().optional(),
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  price_cents: z.number().int().min(0).max(100_000_000).optional(),
  interval: z.enum(["one_time", "month", "year"]).optional(),
}).refine((d) => Object.values(d).some((v) => v !== undefined), { message: "Nothing to update." });

/**
 * PATCH /api/admin/monetization/plans/[id] — staff-only membership plan edits
 * (activate/deactivate + catalog fields). Every change is audit-logged.
 */
export async function PATCH(req: Request, ctxParams: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured.", code: "backend_unconfigured" }, { status: 503 });

  const { id } = await ctxParams.params;
  if (!z.string().trim().min(1).max(80).safeParse(id).success) return NextResponse.json({ error: "Not found." }, { status: 404 });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 422 }); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request.", issues: parsed.error.issues.map((i) => i.message) }, { status: 422 });

  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) update[k] = v;

  const { data, error } = await db.from("membership_plans").update(update).eq("id", id).select("id").maybeSingle();
  if (error) {
    recordLog("error", "monetization_plan_update_failed", { service: "monetization", route: "api/admin/monetization/plans/[id]", attrs: { plan: id, err: error.message.slice(0, 160) } });
    return NextResponse.json({ error: "Couldn't save the plan." }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "Plan not found." }, { status: 404 });

  recordLog("info", "monetization_plan_updated", {
    service: "monetization", route: "api/admin/monetization/plans/[id]",
    attrs: { plan: id, actor: user!.id, fields: Object.keys(update).join(",") },
  });
  return NextResponse.json({ ok: true });
}
