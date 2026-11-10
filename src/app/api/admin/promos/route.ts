import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser } from "@/lib/auth";
import { PROMO_CODE_RE } from "@/lib/promos";
import { serviceClient } from "@/lib/supabase";

const optDate = z.string().trim().optional().transform((v) => (v ? new Date(v) : null)).refine((d) => d === null || !Number.isNaN(d.getTime()), "bad date");
const createSchema = z.object({
  code: z.string().trim().regex(PROMO_CODE_RE),
  kind: z.enum(["percent", "amount"]),
  value: z.coerce.number().positive(),
  starts_at: optDate, expires_at: optDate,
  max_redemptions: z.string().trim().optional().transform((v) => (v ? Number(v) : null)).refine((n) => n === null || (Number.isInteger(n) && n > 0), "bad max"),
});

/** Admin promo management (create / deactivate). Discounts reduce revenue, so mutations are admin-only and audit-logged. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (user?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = await req.formData();
  const action = String(form.get("action") ?? "");
  const back = (result: string, detail?: string) => {
    const url = new URL("/admin/promos", req.url);
    url.searchParams.set("result", result);
    if (detail) url.searchParams.set("detail", detail);
    return NextResponse.redirect(url, 303);
  };
  const actorId = /^[0-9a-f-]{36}$/i.test(user.id) ? user.id : null;

  if (action === "create") {
    const p = createSchema.safeParse({
      code: form.get("code"), kind: form.get("kind"), value: form.get("value"),
      starts_at: form.get("starts_at") || undefined, expires_at: form.get("expires_at") || undefined, max_redemptions: form.get("max_redemptions") || undefined,
    });
    if (!p.success) return back("error", "Check the code (3-32 letters, numbers, - or _), discount and dates.");
    const d = p.data;
    if (d.kind === "percent" && d.value > 100) return back("error", "A percentage can't exceed 100.");
    if (d.kind === "amount" && !(Number.isFinite(d.value) && Math.round(d.value * 100) > 0)) return back("error", "Enter a dollar amount above zero.");
    const { error } = await db.from("promo_codes").insert({
      code: d.code, percent_off: d.kind === "percent" ? d.value : null, amount_off_cents: d.kind === "amount" ? Math.round(d.value * 100) : null,
      starts_at: d.starts_at?.toISOString() ?? null, expires_at: d.expires_at?.toISOString() ?? null, max_redemptions: d.max_redemptions, created_by: actorId,
    });
    if (error) return back("error", error.code === "23505" ? "That code already exists." : "The code could not be created.");
    await auditLog(user.id, "create_promo", "promo", d.code, { kind: d.kind, value: d.value, max: d.max_redemptions });
    return back("created", d.code);
  }

  if (action === "deactivate" || action === "activate") {
    const code = String(form.get("code") ?? "");
    if (!PROMO_CODE_RE.test(code)) return back("error", "Invalid code.");
    const { data, error } = await db.from("promo_codes").update({ active: action === "activate" }).eq("code", code).select("code").maybeSingle();
    if (error || !data) return back("error", "The code could not be updated.");
    await auditLog(user.id, `${action}_promo`, "promo", code);
    return back(action === "activate" ? "activated" : "deactivated", code);
  }

  return back("error", "Unknown promo action.");
}
