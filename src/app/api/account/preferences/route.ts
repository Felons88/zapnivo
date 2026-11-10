import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { clientIp, fail, sameOrigin } from "@/lib/helpdesk/http";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";

const schema = z.object({ notify_sms: z.boolean() });

/** Customer account-level SMS preference (profiles.notify_sms). Per-rental consent still applies at checkout. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, "Cross-origin request rejected.");
  const user = await getSessionUser();
  if (!user) return fail(401, "Please sign in.");
  if (user.role !== "customer") return fail(403, "This setting is for customer accounts.");
  if (!rateLimit(`account-prefs:${user.id}:${clientIp(req)}`, 10, 10 * 60_000).ok) {
    return fail(429, "Too many requests. Please try again later.");
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(422, "Invalid request.");

  const db = serviceClient();
  if (!db) return fail(503, "Account settings aren't available yet.", { code: "backend_unconfigured" });

  const { data, error } = await db
    .from("profiles")
    .update({ notify_sms: parsed.data.notify_sms })
    .eq("id", user.id)
    .select("notify_sms")
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: "error", scope: "account-prefs", msg: error.message }));
    return fail(503, "We couldn't save that preference yet — the privacy migration may not be applied.", { code: "backend_unconfigured" });
  }
  return NextResponse.json({ ok: true, notify_sms: (data as { notify_sms?: boolean } | null)?.notify_sms ?? parsed.data.notify_sms });
}
