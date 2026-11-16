import { NextResponse } from "next/server";
import { z } from "zod";
import { deletionAnonymization } from "@/lib/customer-privacy";
import { isResponse, mobileCustomer } from "@/lib/mobile";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  notify_sms: z.boolean().optional(),
}).refine((v) => v.name !== undefined || v.notify_sms !== undefined);

export async function GET(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  const { data, error } = await c.db.from("profiles").select("full_name,phone,email,notify_sms").eq("id", c.user.id).maybeSingle();
  if (error || !data) {
    // notify_sms comes from the privacy migration; fall back so the account still loads without it.
    const base = await c.db.from("profiles").select("full_name,phone,email").eq("id", c.user.id).maybeSingle();
    if (base.error || !base.data) return NextResponse.json({ error: "Account service unavailable." }, { status: 503 });
    const b = base.data as { full_name: string | null; phone: string | null; email: string | null };
    return NextResponse.json({ id: c.user.id, name: b.full_name, phone: b.phone, email: b.email?.endsWith("@mobile.zapnivo.com") ? null : b.email, notify_sms: false }, { headers: noStore });
  }
  const d = data as { full_name: string | null; phone: string | null; email: string | null; notify_sms: boolean | null };
  return NextResponse.json({
    id: c.user.id, name: d.full_name, phone: d.phone,
    email: d.email?.endsWith("@mobile.zapnivo.com") ? null : d.email, notify_sms: d.notify_sms ?? false,
  }, { headers: noStore });
}

export async function PATCH(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  if (!rateLimit(`mobile-me:${c.user.id}`, 20, 10 * 60_000).ok) return NextResponse.json({ error: "Too many changes. Try again later." }, { status: 429 });
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid name." }, { status: 422 });
  const update: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) update.full_name = parsed.data.name;
  if (parsed.data.notify_sms !== undefined) update.notify_sms = parsed.data.notify_sms;
  const { error } = await c.db.from("profiles").update(update).eq("id", c.user.id);
  if (error) return NextResponse.json({ error: "We couldn't save that change." }, { status: 503 });
  return NextResponse.json({ ok: true });
}

/** Account deletion request (same queue + PII minimization as the website). */
export async function DELETE(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  if (!rateLimit(`mobile-delete:${c.user.id}`, 3, 60 * 60_000).ok) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  const { data: existing } = await c.db.from("customer_data_requests").select("id").eq("kind", "deletion").eq("email", c.email).eq("status", "pending").limit(1);
  if (existing?.length) return NextResponse.json({ ok: true, status: "pending", duplicate: true });
  const { error } = await c.db.from("customer_data_requests").insert({
    user_id: c.user.id, email: c.email, kind: "deletion", status: "pending",
    note: "Customer requested account deletion from the mobile app. Financial records retained per retention policy.",
  });
  if (error) return NextResponse.json({ error: "We couldn't record your request. Please contact support in the app." }, { status: 503 });
  await c.db.from("profiles").update(deletionAnonymization).eq("id", c.user.id);
  return NextResponse.json({ ok: true, status: "pending" });
}
