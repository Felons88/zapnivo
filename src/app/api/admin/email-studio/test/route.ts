import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit";
import { getSessionUser, isStaff } from "@/lib/auth";
import { getMailer, flushOutbox, mailerConfigured } from "@/lib/helpdesk/mailer";
import { getRepo } from "@/lib/helpdesk/repo";
import { getEmailTemplate, htmlToText, renderStudioTemplate } from "@/lib/email-studio";
import { serviceClient } from "@/lib/supabase";

const MAX_VARS = 60;
const MAX_VALUE = 2000;
const KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/admin/email-studio/test — admin-only test send.
 * Body: { template, to, vars? }. The recipient MUST be the admin's own email or
 * another staff/admin profile email — customer addresses are always rejected.
 * Queues through the helpdesk outbox + flush, exactly like the SMS test send.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isStaff(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (user.role !== "admin") return NextResponse.json({ error: "Admins only." }, { status: 403 });

  let body: { template?: unknown; to?: unknown; vars?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const name = typeof body.template === "string" ? body.template : "";
  const spec = getEmailTemplate(name);
  if (!spec) return NextResponse.json({ error: "Unknown template." }, { status: 422 });

  const to = typeof body.to === "string" ? body.to.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(to)) return NextResponse.json({ error: "Enter a valid email address." }, { status: 422 });

  // Recipient restriction: the admin's own address, or a profile with an admin/staff role.
  const own = user.email.toLowerCase() === to;
  let staffRecipient = own;
  if (!own) {
    const db = serviceClient();
    if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
    const { data } = await db
      .from("profiles")
      .select("role")
      .eq("email", to)
      .in("role", ["admin", "staff"])
      .maybeSingle();
    staffRecipient = Boolean(data);
  }
  if (!staffRecipient) {
    return NextResponse.json({ error: "Test sends can only go to your own address or a staff/admin profile email." }, { status: 403 });
  }

  const repo = await getRepo();
  if (!repo) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });

  const vars: Record<string, string> = {};
  if (body.vars && typeof body.vars === "object" && !Array.isArray(body.vars)) {
    const entries = Object.entries(body.vars as Record<string, unknown>).slice(0, MAX_VARS);
    for (const [k, v] of entries) {
      if (!KEY_RE.test(k) || typeof v !== "string") continue;
      vars[k] = v.slice(0, MAX_VALUE);
    }
  }

  const merged = { ...spec.sampleVars, ...vars };
  const out = renderStudioTemplate(spec, merged);
  if (!out.available) {
    return NextResponse.json({ ok: false, available: false, error: out.error }, { status: 422 });
  }

  const subject = `[TEST] ${out.subject}`;
  const body_text = `This is a test send from Email Studio.\n\nTemplate: ${spec.displayName} (${spec.name})\nSubject: ${out.subject}\n\n${htmlToText(out.html)}`;

  await repo.queueEmail({ ticketId: null, to, subject, body: body_text, html: out.html });
  const mailer = getMailer();
  const flush = await flushOutbox(repo, mailer).catch(() => ({ sent: 0, failed: 0, queued: 0 }));

  await auditLog(user.id, "email_studio_test_send", "email_template", spec.name, { to, subject });

  const configured = mailerConfigured();
  return NextResponse.json({
    ok: true,
    queued: flush.queued + flush.sent + flush.failed > 0,
    sent: flush.sent > 0,
    failed: flush.failed > 0,
    mailerConfigured: configured,
    note: configured ? undefined : "Email delivery is not configured — the test is queued in the outbox but won't send until RESEND_API_KEY/BREVO_API_KEY + SUPPORT_FROM_EMAIL are set.",
  });
}
