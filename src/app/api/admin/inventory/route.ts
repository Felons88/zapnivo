import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { adjustStock, createSku, setStockCount, updateSku } from "@/lib/inventory";
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

/** Staff inventory operations. Mutations are audit-logged in the lib; feedback via ?result= 303 redirect. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = await req.formData();
  const action = String(form.get("action") ?? "");
  const rt = String(form.get("return_to") ?? "");
  const dest = /^\/admin\/[A-Za-z0-9/_-]*$/.test(rt) ? rt : "/admin/inventory";
  const back = (result: string, detail?: string) => {
    const url = new URL(dest, req.url);
    url.searchParams.set("result", result);
    if (detail) url.searchParams.set("detail", detail.slice(0, 200));
    return NextResponse.redirect(url, 303);
  };
  const fail = (detail: string) => back("error", detail);
  const actor = user!.id;

  if (action === "sku_create") {
    const cost = num(form.get("unit_cost_cents"));
    const reorder = num(form.get("reorder_point"));
    const res = await createSku(db, actor, {
      category: String(form.get("category") ?? "") as never,
      name: String(form.get("name") ?? ""),
      supplier: str(form.get("supplier")),
      unit_cost_cents: cost,
      reorder_point: reorder ?? undefined,
      track_expiry: form.get("track_expiry") === "1" || form.get("track_expiry") === "on",
      notes: str(form.get("notes")),
    });
    if (!res.ok) return fail(res.error);
    return back("saved", `SKU "${res.sku.name}" created.`);
  }

  if (action === "sku_update") {
    const skuId = String(form.get("sku_id") ?? "");
    if (!skuId) return fail("Missing SKU.");
    const patch: Record<string, unknown> = {};
    const cat = str(form.get("category"));
    if (cat !== null) patch.category = cat;
    const name = str(form.get("name"));
    if (name !== null) patch.name = name;
    if (form.get("supplier") !== null) patch.supplier = str(form.get("supplier"));
    if (form.get("unit_cost_cents") !== null) patch.unit_cost_cents = num(form.get("unit_cost_cents"));
    if (form.get("reorder_point") !== null) patch.reorder_point = num(form.get("reorder_point"));
    if (form.get("track_expiry") !== null) patch.track_expiry = form.get("track_expiry") === "1" || form.get("track_expiry") === "on";
    if (form.get("notes") !== null) patch.notes = str(form.get("notes"));
    if (form.get("active") !== null) patch.active = str(form.get("active")) === "1";
    const res = await updateSku(db, actor, skuId, patch);
    if (!res.ok) return fail(res.error);
    return back("saved", `SKU "${res.sku.name}" updated.`);
  }

  if (action === "stock_adjust") {
    const delta = num(form.get("delta"));
    if (delta === null) return fail("Enter a whole-number delta.");
    const res = await adjustStock(db, actor, {
      sku_id: String(form.get("sku_id") ?? ""),
      unit_id: str(form.get("unit_id")),
      venue_id: str(form.get("venue_id")),
      delta,
      reason: str(form.get("reason")),
    });
    if (!res.ok) return fail(res.error === "insufficient_stock" ? `Not enough stock (have ${res.before ?? 0}).` : res.error);
    return back("saved", `Stock ${delta > 0 ? "+" : ""}${delta} → ${res.after}.`);
  }

  if (action === "stock_set") {
    const qty = num(form.get("qty"));
    if (qty === null) return fail("Enter a whole-number count.");
    const res = await setStockCount(db, actor, {
      sku_id: String(form.get("sku_id") ?? ""),
      unit_id: str(form.get("unit_id")),
      venue_id: str(form.get("venue_id")),
      qty,
      reason: str(form.get("reason")),
    });
    if (!res.ok) return fail(res.error);
    return back("saved", `Count set to ${res.after} (was ${res.before}).`);
  }

  await auditLog(actor, "inventory_unknown_action", "inventory", null, { action });
  return fail("Unknown inventory action.");
}
