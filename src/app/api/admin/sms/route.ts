import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { sendSms, normalizePhone, smsConfigured } from "@/lib/sms";
import { SMS_JOB_KINDS } from "@/lib/notifications";
import { serviceClient } from "@/lib/supabase";

const KINDS = SMS_JOB_KINDS;
const FLAGS = ["sms_enabled", "non_return_billing_enabled"] as const;

/**
 * GET /api/admin/sms — sender/A2P status for staff tooling. Honest about what the
 * Twilio REST API can and can't tell us: A2P 10DLC brand/campaign registration is NOT
 * retrievable without the Messaging API / console, so we report "manual verification".
 */
export async function GET() {
  const user = await getSessionUser();
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = serviceClient();
  const { count: optedOut } = db
    ? await db.from("sms_opt_outs").select("phone", { count: "exact", head: true })
    : { count: null };
  return NextResponse.json({
    configured: {
      accountSid: Boolean(process.env.TWILIO_ACCOUNT_SID),
      authToken: Boolean(process.env.TWILIO_AUTH_TOKEN),
      fromNumber: Boolean(process.env.TWILIO_FROM_NUMBER),
    },
    smsConfigured: smsConfigured(),
    optedOutCount: optedOut ?? null,
    a2pRegistration: {
      status: "manual_verification_required",
      note: "A2P 10DLC brand and campaign registration can't be read through the basic Twilio API. Verify approval in the Twilio console (Messaging → Regulatory → A2P) — until approved, carriers may filter or reject application traffic.",
    },
  });
}

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
