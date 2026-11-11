import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isStaff } from "@/lib/auth";
import { packageCompleteness, packagePatchSchema, type PackageRow } from "@/lib/monetization/catalog-validation";
import { recordLog } from "@/lib/observability";
import { serviceClient } from "@/lib/supabase";

/**
 * PATCH /api/admin/monetization/packages/[id] — staff-only prepaid package edits
 * (activate/deactivate, price_cents, units, validity). Audit-logged.
 * Activation is refused while the merged row is incomplete.
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
  const parsed = packagePatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request.", issues: parsed.error.issues.map((i) => i.message) }, { status: 422 });

  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) update[k] = v;

  // Activation gate: merge the patch over the stored row and require a complete,
  // sellable package before it can appear in the customer catalog.
  if (update.active === true) {
    const { data: current, error: readErr } = await db
      .from("prepaid_packages").select("name,price_cents,units,kind").eq("id", id).maybeSingle();
    if (readErr) {
      recordLog("error", "monetization_package_read_failed", { service: "monetization", route: "api/admin/monetization/packages/[id]", attrs: { package: id, err: readErr.message.slice(0, 160) } });
      return NextResponse.json({ error: "Couldn't load the package." }, { status: 500 });
    }
    if (!current) return NextResponse.json({ error: "Package not found." }, { status: 404 });
    const merged = { ...(current as PackageRow), ...update } as PackageRow;
    const check = packageCompleteness(merged);
    if (!check.complete) {
      return NextResponse.json({
        error: "This package can't be activated yet — complete the missing fields first.",
        code: "package_incomplete",
        missing: check.missing,
      }, { status: 422 });
    }
  }

  const { data, error } = await db.from("prepaid_packages").update(update).eq("id", id).select("id").maybeSingle();
  if (error) {
    recordLog("error", "monetization_package_update_failed", { service: "monetization", route: "api/admin/monetization/packages/[id]", attrs: { package: id, err: error.message.slice(0, 160) } });
    return NextResponse.json({ error: "Couldn't save the package." }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "Package not found." }, { status: 404 });

  recordLog("info", "monetization_package_updated", {
    service: "monetization", route: "api/admin/monetization/packages/[id]",
    attrs: { package: id, actor: user!.id, fields: Object.keys(update).join(",") },
  });
  return NextResponse.json({ ok: true });
}
