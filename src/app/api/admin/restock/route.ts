import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { completeVisit, createVisit, transitionVisit, upsertVisitLine, type VisitStatus } from "@/lib/inventory";
import { serviceClient } from "@/lib/supabase";

const num = (v: FormDataEntryValue | null): number | null => {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: FormDataEntryValue | null): string | null => {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? null : s;
};

/** Staff restock-visit operations. Mutations are audit-logged in the lib; feedback via ?result= 303 redirect. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = await req.formData();
  const action = String(form.get("action") ?? "");
  const rt = String(form.get("return_to") ?? "");
  const dest = /^\/admin\/[A-Za-z0-9/_-]*$/.test(rt) ? rt : "/admin/restock";
  const back = (result: string, detail?: string) => {
    const url = new URL(dest, req.url);
    url.searchParams.set("result", result);
    if (detail) url.searchParams.set("detail", detail.slice(0, 200));
    return NextResponse.redirect(url, 303);
  };
  const fail = (detail: string) => back("error", detail);
  const actor = user!.id;

  if (action === "visit_create") {
    const res = await createVisit(db, actor, {
      unit_id: String(form.get("unit_id") ?? ""),
      technician: str(form.get("technician")),
      scheduled_for: str(form.get("scheduled_for")),
      notes: str(form.get("notes")),
    });
    if (!res.ok) {
      const msg = res.error === "unit_retired" ? "That unit is retired."
        : res.error === "unit_cannot_hold_stock" ? "That unit type cannot hold product stock."
        : res.error === "unit_not_found" ? "Unit not found."
        : res.error;
      return fail(msg);
    }
    return back("saved", "Restock visit planned.");
  }

  if (action === "line_upsert") {
    const res = await upsertVisitLine(db, actor, {
      visit_id: String(form.get("visit_id") ?? ""),
      sku_id: String(form.get("sku_id") ?? ""),
      qty_picked: num(form.get("qty_picked")) ?? undefined,
      qty_loaded: num(form.get("qty_loaded")) ?? undefined,
      qty_waste: num(form.get("qty_waste")) ?? undefined,
    });
    if (!res.ok) {
      return fail(res.error === "visit_closed" ? "This visit is closed — lines can't be edited."
        : res.error === "sku_not_found" ? "SKU not found."
        : res.error === "visit_not_found" ? "Visit not found."
        : res.error);
    }
    return back("saved", "Line saved.");
  }

  if (action === "visit_transition") {
    const visitId = String(form.get("visit_id") ?? "");
    const to = String(form.get("to") ?? "") as VisitStatus;
    if (!["planned", "in_progress", "completed", "cancelled"].includes(to)) return fail("Invalid transition.");
    if (to === "completed") {
      const res = await completeVisit(db, actor, visitId);
      if (!res.ok) return fail(res.error === "visit_cancelled" ? "Cancelled visits can't be completed." : res.error);
      if (res.idempotent) return back("saved", "Visit was already completed — no stock re-applied.");
      const shorts = res.short_picks.length ? ` Short picks (clamped at 0): ${res.short_picks.length}.` : "";
      return back("saved", `Visit completed — ${res.effects.length} line(s) applied.${shorts}`);
    }
    const res = await transitionVisit(db, actor, visitId, to);
    if (!res.ok) {
      return fail(res.error.startsWith("cannot move") ? "That status change isn't allowed."
        : res.error === "visit_not_found" ? "Visit not found." : res.error);
    }
    return back("saved", `Visit ${to === "in_progress" ? "started" : "cancelled"}.`);
  }

  await auditLog(actor, "restock_unknown_action", "restock", null, { action });
  return fail("Unknown restock action.");
}
