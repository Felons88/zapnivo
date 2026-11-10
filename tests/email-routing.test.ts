import { afterEach, describe, expect, it, vi } from "vitest";
import { EMAIL_TEMPLATE_NAMES } from "@/lib/email-templates";
import { EMAIL_SENDERS, resolveSender, type EmailSenderId } from "@/lib/email/senders";
import { EMAIL_TRIGGER_REGISTRY } from "@/lib/email/routing";
import { MemoryRepo } from "@/lib/helpdesk/memory-repo";
import { BrevoMailer, flushOutbox, ResendMailer } from "@/lib/helpdesk/mailer";

const SENDER_IDS: EmailSenderId[] = [
  "general", "support", "partners", "rentals", "billing", "notifications",
  "security", "operations", "legal", "admin", "noreply",
];

describe("sender registry", () => {
  it("defines all 11 department senders with email, display name, and reply-to", () => {
    expect(Object.keys(EMAIL_SENDERS).sort()).toEqual([...SENDER_IDS].sort());
    expect(EMAIL_SENDERS.general).toEqual({ name: "Zapnivo Team", email: "hello@zapnivo.com", replyTo: "hello@zapnivo.com" });
    expect(EMAIL_SENDERS.support).toEqual({ name: "Zapnivo Customer Care", email: "support@zapnivo.com", replyTo: "support@zapnivo.com" });
    expect(EMAIL_SENDERS.partners).toEqual({ name: "Zapnivo Partnerships", email: "partners@zapnivo.com", replyTo: "partners@zapnivo.com" });
    expect(EMAIL_SENDERS.rentals).toEqual({ name: "Zapnivo Rentals", email: "rentals@zapnivo.com", replyTo: "support@zapnivo.com" });
    expect(EMAIL_SENDERS.billing).toEqual({ name: "Zapnivo Billing", email: "billing@zapnivo.com", replyTo: "billing@zapnivo.com" });
    expect(EMAIL_SENDERS.notifications).toEqual({ name: "Zapnivo Notifications", email: "notifications@zapnivo.com", replyTo: "support@zapnivo.com" });
    expect(EMAIL_SENDERS.security).toEqual({ name: "Zapnivo Security", email: "security@zapnivo.com", replyTo: "security@zapnivo.com" });
    expect(EMAIL_SENDERS.operations).toEqual({ name: "Zapnivo Operations", email: "operations@zapnivo.com", replyTo: "operations@zapnivo.com" });
    expect(EMAIL_SENDERS.legal).toEqual({ name: "Zapnivo Legal", email: "legal@zapnivo.com", replyTo: "legal@zapnivo.com" });
    expect(EMAIL_SENDERS.admin).toEqual({ name: "Zapnivo Administration", email: "admin@zapnivo.com", replyTo: "admin@zapnivo.com" });
    expect(EMAIL_SENDERS.noreply).toEqual({ name: "Zapnivo noreply", email: "noreply@zapnivo.com", replyTo: "support@zapnivo.com" });
    for (const s of Object.values(EMAIL_SENDERS)) {
      expect(s.email).toMatch(/@zapnivo\.com$/);
      expect(s.replyTo).toMatch(/@zapnivo\.com$/);
      expect(s.name.length).toBeGreaterThan(0);
    }
  });

  it("resolveSender returns the record for known ids and null otherwise", () => {
    expect(resolveSender("rentals")).toBe(EMAIL_SENDERS.rentals);
    expect(resolveSender("noreply")).toBe(EMAIL_SENDERS.noreply);
    expect(resolveSender("bogus")).toBeNull();
    expect(resolveSender(null)).toBeNull();
    expect(resolveSender(undefined)).toBeNull();
    expect(resolveSender("")).toBeNull();
  });
});

describe("trigger registry", () => {
  it("every entry uses a valid sender id and an honest template/status", () => {
    const templateNames = new Set(EMAIL_TEMPLATE_NAMES);
    for (const [event, e] of Object.entries(EMAIL_TRIGGER_REGISTRY)) {
      expect(SENDER_IDS, `${event} sender`).toContain(e.sender);
      expect(e.recipientKind).toMatch(/^(customer|applicant|partner|staff)$/);
      expect(e.description.length).toBeGreaterThan(0);
      if (e.status === "wired" && e.template !== null) {
        expect(templateNames.has(e.template), `${event} template ${e.template}`).toBe(true);
      }
      if (e.status === "no_template") expect(e.template).toBeNull();
    }
  });

  it("covers the implemented wired events", () => {
    for (const event of [
      "support.ticket.created", "support.ticket.updated", "support.ticket.agent_reply",
      "rental.started", "rental.returned", "rental.reminder", "rental.nonreturn_notice",
      "rental.payment_failed", "payment.receipt", "payment.refund",
      "partner.application.received", "partner.application.staff_alert", "partner.approved",
      "partner.revenue_statement", "station.offline", "payment.dispute.opened",
      "security.alert", "admin.cron_failed",
    ]) {
      expect(EMAIL_TRIGGER_REGISTRY[event as keyof typeof EMAIL_TRIGGER_REGISTRY]?.status).toBe("wired");
    }
  });

  it("has no duplicate event keys", () => {
    const keys = Object.keys(EMAIL_TRIGGER_REGISTRY);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("outbox routing fields", () => {
  it("MemoryRepo round-trips sender/replyTo/template/event", async () => {
    const repo = new MemoryRepo();
    const queued = await repo.queueEmail({
      ticketId: null, to: "c@example.com", subject: "s", body: "b", html: null,
      sender: "rentals", replyTo: null, template: "rental_started", event: "rental.started",
    });
    expect(queued.sender).toBe("rentals");
    expect(queued.template).toBe("rental_started");
    expect(queued.event).toBe("rental.started");
    const [listed] = await repo.listEmails("queued");
    expect(listed.sender).toBe("rentals");
    expect(listed.template).toBe("rental_started");
    expect(listed.event).toBe("rental.started");
    expect(listed.replyTo).toBeNull();
  });

  it("legacy queueEmail calls without routing fields store nulls", async () => {
    const repo = new MemoryRepo();
    const queued = await repo.queueEmail({ ticketId: null, to: "a@b.co", subject: "s", body: "b", html: null });
    expect(queued.sender).toBeNull();
    expect(queued.replyTo).toBeNull();
    expect(queued.template).toBeNull();
    expect(queued.event).toBeNull();
  });
});

describe("mailers", () => {
  afterEach(() => vi.unstubAllGlobals());

  const mockFetch = () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", spy);
    return spy;
  };

  it("BrevoMailer sends custom from and replyTo", async () => {
    process.env.BREVO_API_KEY = "k";
    process.env.SUPPORT_FROM_EMAIL = "Zapnivo Support <support@zapnivo.com>";
    const spy = mockFetch();
    await new BrevoMailer().send({
      to: "c@example.com", subject: "hi", body: "b",
      from: { name: "Zapnivo Rentals", email: "rentals@zapnivo.com" },
      replyTo: "support@zapnivo.com",
    });
    const payload = JSON.parse(String(spy.mock.calls[0][1]?.body));
    expect(payload.sender).toEqual({ name: "Zapnivo Rentals", email: "rentals@zapnivo.com" });
    expect(payload.replyTo).toEqual({ email: "support@zapnivo.com" });
    delete process.env.BREVO_API_KEY;
  });

  it("BrevoMailer falls back to SUPPORT_FROM_EMAIL and omits replyTo when absent", async () => {
    process.env.BREVO_API_KEY = "k";
    process.env.SUPPORT_FROM_EMAIL = "Zapnivo Support <support@zapnivo.com>";
    const spy = mockFetch();
    await new BrevoMailer().send({ to: "c@example.com", subject: "hi", body: "b" });
    const payload = JSON.parse(String(spy.mock.calls[0][1]?.body));
    expect(payload.sender).toEqual({ name: "Zapnivo Support", email: "support@zapnivo.com" });
    expect("replyTo" in payload).toBe(false);
    delete process.env.BREVO_API_KEY;
  });

  it("ResendMailer sends formatted from and reply_to", async () => {
    process.env.RESEND_API_KEY = "k";
    process.env.SUPPORT_FROM_EMAIL = "support@zapnivo.com";
    const spy = mockFetch();
    await new ResendMailer().send({
      to: "c@example.com", subject: "hi", body: "b",
      from: { name: "Zapnivo Billing", email: "billing@zapnivo.com" },
      replyTo: "billing@zapnivo.com",
    });
    const payload = JSON.parse(String(spy.mock.calls[0][1]?.body));
    expect(payload.from).toBe("Zapnivo Billing <billing@zapnivo.com>");
    expect(payload.reply_to).toBe("billing@zapnivo.com");
    delete process.env.RESEND_API_KEY;
  });
});

describe("flushOutbox sender resolution", () => {
  it("maps sender id to from + registry replyTo", async () => {
    const repo = new MemoryRepo();
    await repo.queueEmail({ ticketId: null, to: "c@example.com", subject: "s", body: "b", html: null, sender: "rentals" });
    const sent: { from?: unknown; replyTo?: unknown }[] = [];
    await flushOutbox(repo, { send: async (m) => { sent.push(m); } });
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toEqual({ name: "Zapnivo Rentals", email: "rentals@zapnivo.com" });
    expect(sent[0].replyTo).toBe("support@zapnivo.com");
    const [e] = await repo.listEmails("sent");
    expect(e.status).toBe("sent");
  });

  it("unknown sender falls back to env (from null, replyTo null)", async () => {
    const repo = new MemoryRepo();
    await repo.queueEmail({ ticketId: null, to: "c@example.com", subject: "s", body: "b", html: null, sender: "bogus" });
    const sent: { from?: unknown; replyTo?: unknown }[] = [];
    await flushOutbox(repo, { send: async (m) => { sent.push(m); } });
    expect(sent[0].from).toBeNull();
    expect(sent[0].replyTo).toBeNull();
  });

  it("explicit replyTo override wins over registry", async () => {
    const repo = new MemoryRepo();
    await repo.queueEmail({ ticketId: null, to: "c@example.com", subject: "s", body: "b", html: null, sender: "billing", replyTo: "finance@zapnivo.com" });
    const sent: { replyTo?: unknown }[] = [];
    await flushOutbox(repo, { send: async (m) => { sent.push(m); } });
    expect(sent[0].replyTo).toBe("finance@zapnivo.com");
  });
});
