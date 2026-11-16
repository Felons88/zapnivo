import { NextResponse } from "next/server";
import { z } from "zod";
import { isResponse, mobileCustomer } from "@/lib/mobile";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const schema = z.object({
  token: z.string().trim().min(20).max(4096),
  platform: z.enum(["android", "ios"]).default("android"),
  app_version: z.string().trim().max(40).optional(),
});

/** Registers (or re-assigns) this device's FCM token to the signed-in customer. */
export async function POST(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  if (!rateLimit(`mobile-device:${c.user.id}`, 20, 10 * 60_000).ok) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid device token." }, { status: 422 });
  const { error } = await c.db.from("mobile_devices").upsert(
    { user_id: c.user.id, token: parsed.data.token, platform: parsed.data.platform, app_version: parsed.data.app_version ?? null, last_seen_at: new Date().toISOString() },
    { onConflict: "token" },
  );
  if (error) return NextResponse.json({ error: "Push registration unavailable." }, { status: 503 });
  return NextResponse.json({ ok: true });
}

/** Called on sign-out so a shared phone stops receiving the previous user's notifications. */
export async function DELETE(req: Request) {
  const c = await mobileCustomer(req);
  if (isResponse(c)) return c;
  const parsed = z.object({ token: z.string().min(20).max(4096) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid device token." }, { status: 422 });
  await c.db.from("mobile_devices").delete().eq("token", parsed.data.token).eq("user_id", c.user.id);
  return NextResponse.json({ ok: true });
}
