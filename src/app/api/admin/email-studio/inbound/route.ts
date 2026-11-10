import { NextResponse } from "next/server";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";
import type { StudioInboundRow } from "@/lib/email-studio";

const MAX_ROWS = 100;

type InboundDbRow = {
  id: string;
  message_id?: string | null;
  from_email?: string | null;
  to_address?: string | null;
  subject?: string | null;
  ticket_number?: string | null;
  status?: string | null;
  reason?: string | null;
  auth_method?: string | null;
  dmarc_result?: string | null;
  spf_result?: string | null;
  dkim_result?: string | null;
  body_preview?: string | null;
  processed_ms?: number | null;
  created_at?: string | null;
};

const toRow = (r: InboundDbRow): StudioInboundRow => ({
  id: r.id,
  messageId: r.message_id ?? null,
  fromEmail: r.from_email ?? null,
  toAddress: r.to_address ?? null,
  subject: r.subject ?? null,
  ticketNumber: r.ticket_number ?? null,
  status: r.status ?? "error",
  reason: r.reason ?? null,
  authMethod: r.auth_method ?? null,
  dmarcResult: r.dmarc_result ?? null,
  spfResult: r.spf_result ?? null,
  dkimResult: r.dkim_result ?? null,
  bodyPreview: r.body_preview ?? null,
  processedMs: typeof r.processed_ms === "number" ? r.processed_ms : null,
  createdAt: r.created_at ?? "",
});

/**
 * GET /api/admin/email-studio/inbound — staff-only.
 * Recent inbound_emails rows (received/processed support mail), newest first,
 * capped at 100. Returns only the safe column set — raw headers and full
 * bodies are never exposed.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const db = serviceClient();
  if (!db) {
    return NextResponse.json({
      ok: true,
      available: false,
      emails: [] as StudioInboundRow[],
      note: "Inbound email processing isn't available — the database isn't configured in this environment.",
    });
  }

  const [{ data, error }, queue] = await Promise.all([
    db.from("inbound_emails").select("*").order("created_at", { ascending: false }).limit(MAX_ROWS),
    db.from("inbound_jobs").select("status").in("status", ["queued", "processing", "dead"]),
  ]);

  if (error) {
    return NextResponse.json({
      ok: true,
      available: false,
      emails: [] as StudioInboundRow[],
      note: "The inbound email log isn't available in this environment yet (table may not exist).",
    });
  }

  const jobs = (queue.data ?? []) as { status: string }[];
  const queueStats = {
    queued: jobs.filter((j) => j.status === "queued").length,
    processing: jobs.filter((j) => j.status === "processing").length,
    dead: jobs.filter((j) => j.status === "dead").length,
  };
  const emails = ((data ?? []) as InboundDbRow[]).map(toRow);
  return NextResponse.json({ ok: true, available: true, emails, cap: MAX_ROWS, queue: queueStats });
}
