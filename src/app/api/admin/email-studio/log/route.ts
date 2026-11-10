import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { getRepo } from "@/lib/helpdesk/repo";
import { EMAIL_SENDERS } from "@/lib/email/senders";
import { senderDisplayName, type StudioLogRow } from "@/lib/email-studio";

const MAX_ROWS = 100;

/**
 * GET /api/admin/email-studio/log — staff-only.
 * Recent email_outbox entries (queued/sent/failed), newest first, capped at 100.
 * Sender ids are resolved to display names via the sender registry.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const repo = await getRepo();
  if (!repo) {
    return NextResponse.json({
      ok: true,
      available: false,
      emails: [] as StudioLogRow[],
      note: "The email outbox isn't available — the helpdesk backend isn't configured in this environment.",
    });
  }

  const all = await repo.listEmails();
  const emails: StudioLogRow[] = all
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_ROWS)
    .map((e) => ({
      id: e.id,
      to: e.to,
      subject: e.subject,
      status: e.status,
      createdAt: e.createdAt,
      error: e.error ?? null,
      // Older repos/types may not carry the routing fields yet — read defensively.
      sender: (e as { sender?: string | null }).sender ?? null,
      replyTo: (e as { replyTo?: string | null }).replyTo ?? null,
      template: (e as { template?: string | null }).template ?? null,
      event: (e as { event?: string | null }).event ?? null,
      senderName: senderDisplayName((e as { sender?: string | null }).sender ?? null, EMAIL_SENDERS),
    }));

  return NextResponse.json({ ok: true, available: true, emails, cap: MAX_ROWS });
}
