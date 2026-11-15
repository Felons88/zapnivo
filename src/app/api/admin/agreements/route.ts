import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { recordLog } from "@/lib/observability";
import { serviceClient } from "@/lib/supabase";
import { approveAgreement, createAgreementDraft, terminateAgreement } from "@/lib/vending-agreements";

const back = (req: Request, result: string, detail?: string) => {
  const url = new URL("/admin/agreements", req.url);
  url.searchParams.set("result", result);
  if (detail) url.searchParams.set("detail", detail);
  return NextResponse.redirect(url, 303);
};

const draftSchema = z.object({
  venue_id: z.string().uuid(),
  equipment_category: z.string().trim().min(1).max(60),
  revenue_share_pct: z.union([z.literal(""), z.coerce.number().min(0).max(100)]).optional(),
  effective_from: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional(),
  notes: z.string().trim().max(500).optional(),
});
const idSchema = z.object({ agreement_id: z.string().uuid() });

/**
 * Staff equipment-agreement operations. create_draft is staff-level;
 * approve/terminate are admin-only — agreements change partner revenue terms,
 * so they require the higher role. Every action is audit-logged.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = await req.formData();
  const action = String(form.get("action") ?? "");

  if (action === "create_draft") {
    const p = draftSchema.safeParse({
      venue_id: form.get("venue_id"),
      equipment_category: form.get("equipment_category"),
      revenue_share_pct: form.get("revenue_share_pct") ?? "",
      effective_from: form.get("effective_from") ?? "",
      notes: form.get("notes") ?? "",
    });
    if (!p.success) return back(req, "error", "Check the agreement fields.");
    const terms = p.data.notes ? { notes: p.data.notes } : {};
    const res = await createAgreementDraft(db, { id: user!.id }, {
      venue_id: p.data.venue_id,
      equipment_category: p.data.equipment_category,
      revenue_share_pct: p.data.revenue_share_pct === "" ? null : p.data.revenue_share_pct,
      terms,
      effective_from: p.data.effective_from === "" ? null : p.data.effective_from,
    });
    if (!res.ok) return back(req, "error", res.error);
    await auditLog(user!.id, "agreement_draft", "equipment_agreement", res.agreement.id, { venue_id: res.agreement.venue_id, category: res.agreement.equipment_category, version: res.agreement.version });
    recordLog("info", "agreement_draft_created", { service: "agreements", route: "admin/agreements", attrs: { agreementId: res.agreement.id, version: res.agreement.version } });
    return back(req, "draft");
  }

  if (action === "approve" || action === "terminate") {
    if (user!.role !== "admin") return back(req, "error", "Only admins can approve or terminate agreements.");
    const p = idSchema.safeParse({ agreement_id: form.get("agreement_id") });
    if (!p.success) return back(req, "error", "Unknown agreement.");
    const reason = action === "terminate" ? String(form.get("reason") ?? "") || null : null;
    const res = action === "approve"
      ? await approveAgreement(db, { id: user!.id }, p.data.agreement_id)
      : await terminateAgreement(db, { id: user!.id }, p.data.agreement_id, reason);
    if (!res.ok) return back(req, "error", res.error);
    await auditLog(user!.id, `agreement_${action}`, "equipment_agreement", res.agreement.id, { venue_id: res.agreement.venue_id, category: res.agreement.equipment_category, version: res.agreement.version, status: res.agreement.status });
    recordLog("info", `agreement_${action}d`, { service: "agreements", route: "admin/agreements", attrs: { agreementId: res.agreement.id } });
    return back(req, action === "approve" ? "approved" : "terminated");
  }

  return back(req, "error", "Unknown agreement action.");
}
