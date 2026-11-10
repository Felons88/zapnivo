import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { sendSms, normalizePhone } from "@/lib/sms";
import { serviceClient } from "@/lib/supabase";

const KINDS = ["activation", "reminder_1h", "reminder_3h", "reminder_6h", "reminder_12h", "warning_20h", "warning_23h", "deadline_24h"] as const;
const FLAGS = ["sms_enabled", "non_return_billing_enabled"] as const;

/** SMS + billing controls. Templates any staff may edit; kill switches and test sends are admin-only. */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const form = await req.formData();
  const action = String(form.get("action") ?? "");
  const back = () => NextResponse.redirect(new URL("/admin/sms", req.url), 303);

  if (action === "save_template") {
    const p = z.object({ kind: z.enum(KINDS), body: z.string().trim().min(10).max(480) }).safeParse({ kind: form.get("kind"), body: form.get("body") });
    if (!p.success) return NextResponse.json({ error: "Template must be 10–480 chars." }, { status: 422 });
    const { error } = await db.from("sms_templates").upsert({ kind: p.data.kind, body: p.data.body, updated_by: /^[0-9a-f-]{36}$/i.test(user!.id) ? user!.id : null, updated_at: new Date().toISOString() });
    if (error) return NextResponse.json({ error: "Couldn't save." }, { status: 500 });
    await auditLog(user!.id, "save_sms_template", "system", p.data.kind);
    return back();
  }

  if (user!.role !== "admin") return NextResponse.json({ error: "Admins only." }, { status: 403 });

  if (action === "set_flag") {
    const key = String(form.get("key") ?? "") as (typeof FLAGS)[number];
    if (!FLAGS.includes(key)) return NextResponse.json({ error: "Unknown flag." }, { status: 422 });
    const value = String(form.get("value") ?? "");
    if (!["true", "false"].includes(value)) return NextResponse.json({ error: "Invalid value." }, { status: 422 });
    const { error } = await db.from("system_config").upsert({ key, value });
    if (error) return NextResponse.json({ error: "Couldn't save." }, { status: 500 });
    await auditLog(user!.id, value === "true" ? "enable" : "disable" + "_flag", "system", key);
    return back();
  }

  if (action === "test_send") {
    const to = normalizePhone(String(form.get("to") ?? ""));
    if (!to) return NextResponse.json({ error: "Enter a valid phone number." }, { status: 422 });
    const res = await sendSms(db, { to, body: "Zapnivo test message — your SMS setup is working." });
    await auditLog(user!.id, "sms_test_send", "system", null, { ok: res.sent });
    return NextResponse.redirect(new URL(res.sent ? "/admin/sms?result=sent" : "/admin/sms?result=notconfigured", req.url), 303);
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
