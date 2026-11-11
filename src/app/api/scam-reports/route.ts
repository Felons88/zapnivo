import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { serviceClient } from "@/lib/supabase";
import { recordLog } from "@/lib/observability";
import { auditLog } from "@/lib/audit";
import { sendToCustomer } from "@/lib/email-triggers";
import { CONTACTS } from "@/lib/contacts";
import { looksLikeCardNumber } from "@/lib/validation";
import { formatReportMessage, REPORT_ANON_EMAIL, scamReportSchema } from "@/lib/scam-report";

const clientIp = (req: Request) =>
  req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";

/**
 * Public scam/fraud report intake. JSON only — file attachments are rejected
 * (anything that isn't a JSON body fails parsing below). Reports land in the
 * existing contact_messages pipeline (queue='general', kind: scam_report header)
 * and notify the security inbox. See src/lib/scam-report.ts for the storage note.
 */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const rl = rateLimit(`scam-report:${clientIp(req)}`, 5, 10 * 60_000);
  if (!rl.ok) {
    return NextResponse.json({ error: "Too many submissions. Please try again later." }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }

  const parsed = scamReportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Please check the highlighted fields.", fields: parsed.error.flatten().fieldErrors }, { status: 422 });
  }
  const d = parsed.data;
  if (d.website) return NextResponse.json({ ok: true }); // honeypot: silently drop bots

  if (looksLikeCardNumber(d.description) || (d.sender_or_url && looksLikeCardNumber(d.sender_or_url))) {
    return NextResponse.json({ error: "Please remove anything that looks like a payment card number. We never need it." }, { status: 422 });
  }

  const db = serviceClient();
  if (!db) {
    return NextResponse.json({ error: `Reports are not available yet. Please email ${CONTACTS.security.email} instead.`, code: "backend_unconfigured" }, { status: 503 });
  }

  const { data: row, error } = await db
    .from("contact_messages")
    .insert({
      queue: "general",
      name: d.contact_email ? d.contact_email.split("@")[0] : "Scam report",
      email: d.contact_email ?? REPORT_ANON_EMAIL,
      message: formatReportMessage(d),
    })
    .select("id")
    .single();
  if (error || !row) {
    console.error(JSON.stringify({ level: "error", scope: "scam-report", msg: "insert_failed", code: error?.code }));
    recordLog("error", "scam_report_failed", { service: "scam-report", attrs: { code: error?.code } });
    return NextResponse.json({ error: "We couldn't save your report. Please try again." }, { status: 500 });
  }

  recordLog("info", "scam_report_submitted", { service: "scam-report", attrs: { id: row.id, category: d.category } });
  void auditLog(null, "scam_report.submitted", "contact_messages", row.id as string, { category: d.category });

  // Best-effort staff notification to the security inbox — never fails the submission.
  try {
    const when = d.occurred_on ?? "unknown date";
    await sendToCustomer(
      CONTACTS.security.email,
      `Scam report: ${d.category} (received ${new Date().toISOString().slice(0, 10)})`,
      `A member of the public reported a suspected scam via /scam-awareness/report.\n\n` +
        `Category: ${d.category}\nOccurred: ${when}\nStation: ${d.station_id ?? "—"}\n` +
        `Sender/URL: ${d.sender_or_url ?? "—"}\nReporter email: ${d.contact_email ?? "not provided"}\n\n` +
        `Contact message id: ${row.id}\n\n---\n${d.description}`,
      null,
      null,
      { sender: "security", event: "security.scam_report" },
    );
  } catch { /* notification failure never fails the submission */ }

  return NextResponse.json({ ok: true, id: row.id });
}
