import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { EMAIL_SENDERS, type EmailSenderId } from "@/lib/email/senders";
import { EMAIL_TRIGGER_REGISTRY } from "@/lib/email/routing";
import type { StudioSenderRow } from "@/lib/email-studio";

/**
 * GET /api/admin/email-studio/senders — staff-only.
 * Lists every configured sender identity plus which routing-registry events
 * send as it. Honest scope: these are configured From addresses — inbound
 * mail to them is NOT verified here.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Which registry events use each sender id (defensive: sender may be missing/misspelled).
  const usage = new Map<string, string[]>();
  for (const [event, t] of Object.entries(EMAIL_TRIGGER_REGISTRY)) {
    const sid = typeof t?.sender === "string" ? t.sender : null;
    if (!sid) continue;
    const list = usage.get(sid) ?? [];
    list.push(event);
    usage.set(sid, list);
  }

  const senders: StudioSenderRow[] = (Object.keys(EMAIL_SENDERS) as EmailSenderId[])
    .sort()
    .map((id) => {
      const s = EMAIL_SENDERS[id];
      return {
        id,
        name: s.name,
        email: s.email,
        replyTo: s.replyTo,
        triggers: (usage.get(id) ?? []).sort(),
      };
    });

  return NextResponse.json({
    ok: true,
    available: true,
    senders,
    note: "Sender addresses are configured for outbound mail only — inbound delivery to these addresses is not verified.",
  });
}
