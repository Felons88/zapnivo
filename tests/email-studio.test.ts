import { beforeEach, describe, expect, it, vi } from "vitest";

const { session, serviceClientMock, repoHolder } = vi.hoisted(() => ({
  session: vi.fn(),
  serviceClientMock: vi.fn(),
  repoHolder: { repo: null as unknown },
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: session,
  isStaff: (u: { role?: string } | null) => u?.role === "admin" || u?.role === "staff",
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: serviceClientMock, anonClient: () => null, backendConfigured: () => true }));
vi.mock("@/lib/helpdesk/repo", () => ({ getRepo: async () => repoHolder.repo }));

import { POST as previewPOST } from "@/app/api/admin/email-studio/preview/route";
import { POST as testPOST } from "@/app/api/admin/email-studio/test/route";
import { GET as sendersGET } from "@/app/api/admin/email-studio/senders/route";
import { GET as triggersGET } from "@/app/api/admin/email-studio/triggers/route";
import { GET as logGET } from "@/app/api/admin/email-studio/log/route";
import { GET as inboundGET } from "@/app/api/admin/email-studio/inbound/route";
import { EMAIL_AUDIENCES, EMAIL_TEMPLATES, getEmailTemplate, htmlToText, inboundStatusCounts, inboundStatusLabel, renderStudioTemplate } from "@/lib/email-studio";
import { EMAIL_SENDERS } from "@/lib/email/senders";
import { EMAIL_TRIGGER_REGISTRY } from "@/lib/email/routing";
import { MemoryRepo } from "@/lib/helpdesk/memory-repo";

const ADMIN = { id: "11111111-1111-4111-8111-111111111111", email: "admin@zapnivo.com", role: "admin", organizationId: null };
const STAFF = { id: "22222222-2222-4222-8222-222222222222", email: "agent@zapnivo.com", role: "staff", organizationId: null };
const CUSTOMER = { id: "33333333-3333-4333-8333-333333333333", email: "customer@example.com", role: "customer", organizationId: null };

const post = (url: string, payload: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
const get = (url: string) => new Request(`http://localhost${url}`);

/** Fake profiles table: only emails in `staffEmails` resolve as staff recipients. */
function dbWithStaff(staffEmails: string[]) {
  return {
    from: (table: string) => {
      if (table !== "profiles") throw new Error(`unexpected table ${table}`);
      let emailFilter: string | null = null;
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (_k: string, v: string) => { emailFilter = v; return q; };
      q.in = () => q;
      q.maybeSingle = async () => ({
        data: emailFilter && staffEmails.includes(emailFilter.toLowerCase()) ? { role: "staff" } : null,
        error: null,
      });
      return q;
    },
  };
}

describe("email-studio registry", () => {
  it("covers every known template name exactly once", () => {
    const names = EMAIL_TEMPLATES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of [
      "nonreturn_notice", "partner_inquiry", "payment_receipt", "refund_processed",
      "rental_reminder", "rental_returned", "rental_started", "support_created", "support_updated",
      "payment_failed", "partner_application_received", "partner_approved", "revenue_statement",
      "station_offline", "payment_dispute", "security_alert",
    ]) {
      expect(names, `missing registry entry for ${n}`).toContain(n);
    }
  });

  it("every entry has an audience, subject, description and sample vars", () => {
    for (const t of EMAIL_TEMPLATES) {
      expect(EMAIL_AUDIENCES).toContain(t.audience);
      expect(t.displayName.length).toBeGreaterThan(0);
      expect(t.subject.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(Object.keys(t.sampleVars).length).toBeGreaterThan(0);
      expect(t.textVars.length).toBeGreaterThan(0);
    }
  });

  it("getEmailTemplate resolves names and misses unknowns", () => {
    expect(getEmailTemplate("rental_started")?.audience).toBe("Customers");
    expect(getEmailTemplate("nope")).toBeUndefined();
  });
});

describe("renderStudioTemplate", () => {
  it("renders a known template with sample vars", () => {
    const spec = getEmailTemplate("rental_started")!;
    const out = renderStudioTemplate(spec, spec.sampleVars);
    expect(out.available).toBe(true);
    if (out.available) {
      expect(out.html).toContain("ZR-8F2KQ1");
      expect(out.html).not.toContain("{{rental_id}}");
      expect(out.subject).toBe(spec.subject);
    }
  });

  it("degrades honestly for templates renderEmail doesn't know yet", () => {
    // A registry entry ahead of the renderer must not throw.
    const spec = { ...getEmailTemplate("rental_started")!, name: "future_template", sampleVars: { rental_id: "ZR-TEST" } };
    const out = renderStudioTemplate(spec, spec.sampleVars);
    expect(out.available).toBe(false);
    expect(out.vars).toContain("rental_id");
  });

  it("htmlToText strips tags and decodes entities", () => {
    expect(htmlToText("<p>Hi &amp; bye<br>line2</p>")).toContain("Hi & bye");
    expect(htmlToText("<style>x{}</style><p>ok</p>")).not.toContain("x{}");
  });
});

describe("preview API auth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401 for anonymous, 403 for customers, 200 for staff", async () => {
    session.mockResolvedValueOnce(null);
    expect((await previewPOST(post("/api/admin/email-studio/preview", { template: "rental_started" }))).status).toBe(401);

    session.mockResolvedValueOnce(CUSTOMER);
    expect((await previewPOST(post("/api/admin/email-studio/preview", { template: "rental_started" }))).status).toBe(403);

    session.mockResolvedValueOnce(STAFF);
    const res = await previewPOST(post("/api/admin/email-studio/preview", { template: "rental_started" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.name).toBe("rental_started");
    expect(data.vars).toContain("rental_id");
  });

  it("rejects unknown template names with 422", async () => {
    session.mockResolvedValueOnce(STAFF);
    expect((await previewPOST(post("/api/admin/email-studio/preview", { template: "bogus" }))).status).toBe(422);
  });

  it("escapes XSS probe vars in the rendered HTML", async () => {
    session.mockResolvedValueOnce(STAFF);
    const probe = '<img src=x onerror=alert(1)>';
    const res = await previewPOST(post("/api/admin/email-studio/preview", {
      template: "rental_started", vars: { rental_id: probe },
    }));
    const data = await res.json();
    expect(data.available).toBe(true);
    expect(data.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(data.html).not.toContain("<img src=x onerror=alert(1)>");
  });
});

describe("test-send API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoHolder.repo = new MemoryRepo();
    serviceClientMock.mockReturnValue(dbWithStaff(["agent@zapnivo.com"]));
  });

  it("401 anon, 403 customer, 403 non-admin staff", async () => {
    session.mockResolvedValueOnce(null);
    expect((await testPOST(post("/api/admin/email-studio/test", { template: "rental_started", to: "admin@zapnivo.com" }))).status).toBe(401);
    session.mockResolvedValueOnce(CUSTOMER);
    expect((await testPOST(post("/api/admin/email-studio/test", { template: "rental_started", to: "admin@zapnivo.com" }))).status).toBe(403);
    session.mockResolvedValueOnce(STAFF); // staff but not admin
    expect((await testPOST(post("/api/admin/email-studio/test", { template: "rental_started", to: "agent@zapnivo.com" }))).status).toBe(403);
  });

  it("rejects customer/arbitrary recipient addresses", async () => {
    session.mockResolvedValue(ADMIN);
    const res = await testPOST(post("/api/admin/email-studio/test", { template: "rental_started", to: "victim@example.com" }));
    expect(res.status).toBe(403);
    const repo = repoHolder.repo as MemoryRepo;
    expect(await repo.listEmails()).toHaveLength(0);
  });

  it("queues a [TEST] send to a staff profile email", async () => {
    session.mockResolvedValue(ADMIN);
    const res = await testPOST(post("/api/admin/email-studio/test", { template: "rental_started", to: "agent@zapnivo.com" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    // No mailer env in tests → honestly reported as queued, not sent.
    expect(data.mailerConfigured).toBe(false);
    const emails = await (repoHolder.repo as MemoryRepo).listEmails("queued");
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toBe("agent@zapnivo.com");
    expect(emails[0].subject).toMatch(/^\[TEST\] /);
    expect(emails[0].html).toContain("ZR-8F2KQ1");
  });

  it("allows the admin's own address without a profiles lookup", async () => {
    session.mockResolvedValue(ADMIN);
    serviceClientMock.mockReturnValue(null); // must not even need the db
    const res = await testPOST(post("/api/admin/email-studio/test", { template: "rental_started", to: "Admin@Zapnivo.com" }));
    expect(res.status).toBe(200);
  });

  it("rejects an unknown sender id with 422", async () => {
    session.mockResolvedValue(ADMIN);
    const res = await testPOST(post("/api/admin/email-studio/test", {
      template: "rental_started", to: "admin@zapnivo.com", sender: "bogus_sender",
    }));
    expect(res.status).toBe(422);
    expect(await (repoHolder.repo as MemoryRepo).listEmails()).toHaveLength(0);
  });

  it("passes sender/replyTo/template/event into queueEmail when sender is provided", async () => {
    session.mockResolvedValue(ADMIN);
    const res = await testPOST(post("/api/admin/email-studio/test", {
      template: "rental_started", to: "admin@zapnivo.com", sender: "support",
    }));
    expect(res.status).toBe(200);
    const emails = await (repoHolder.repo as MemoryRepo).listEmails("queued");
    expect(emails).toHaveLength(1);
    expect(emails[0].sender).toBe("support");
    expect(emails[0].replyTo).toBe(EMAIL_SENDERS.support.replyTo);
    expect(emails[0].template).toBe("rental_started");
    // The routing registry maps rental_started → event "rental.started".
    expect(emails[0].event).toBe("rental.started");
  });

  it("defaults to the template's natural sender when sender is omitted", async () => {
    session.mockResolvedValue(ADMIN);
    const res = await testPOST(post("/api/admin/email-studio/test", {
      template: "rental_started", to: "admin@zapnivo.com",
    }));
    expect(res.status).toBe(200);
    const emails = await (repoHolder.repo as MemoryRepo).listEmails("queued");
    expect(emails[0].sender).toBe("rentals"); // natural sender for rental.started
    expect(emails[0].replyTo).toBe(EMAIL_SENDERS.rentals.replyTo);
  });
});

describe("senders API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401 anon, 403 customer, 200 staff with registry shape", async () => {
    session.mockResolvedValueOnce(null);
    expect((await sendersGET()).status).toBe(401);
    session.mockResolvedValueOnce(CUSTOMER);
    expect((await sendersGET()).status).toBe(403);

    session.mockResolvedValueOnce(STAFF);
    const res = await sendersGET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.available).toBe(true);
    expect(data.senders).toHaveLength(Object.keys(EMAIL_SENDERS).length);
    for (const s of data.senders) {
      expect(s.id).toBeTruthy();
      expect(s.name).toBeTruthy();
      expect(s.email).toContain("@");
      expect(s.replyTo).toContain("@");
      expect(Array.isArray(s.triggers)).toBe(true);
    }
    // support sender is used by the support.ticket.* triggers.
    const support = data.senders.find((s: { id: string }) => s.id === "support");
    expect(support.triggers).toContain("support.ticket.created");
  });
});

describe("triggers API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401 anon, 403 customer, 200 staff mirrors the routing registry", async () => {
    session.mockResolvedValueOnce(null);
    expect((await triggersGET()).status).toBe(401);
    session.mockResolvedValueOnce(CUSTOMER);
    expect((await triggersGET()).status).toBe(403);

    session.mockResolvedValueOnce(STAFF);
    const res = await triggersGET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.triggers).toHaveLength(Object.keys(EMAIL_TRIGGER_REGISTRY).length);
    const rental = data.triggers.find((t: { event: string }) => t.event === "rental.started");
    expect(rental).toMatchObject({ sender: "rentals", template: "rental_started", recipientKind: "customer", status: "wired" });
    // Unknown/future statuses would pass through untouched — registry statuses are preserved raw.
    for (const t of data.triggers) expect(typeof t.status).toBe("string");
  });
});

/** Fake inbound_emails table: .select().order().limit() resolves to the canned result. */
function dbWithInbound(result: { data?: unknown[] | null; error?: { message: string } | null }) {
  return {
    from: (table: string) => {
      if (table === "inbound_jobs") {
        // queue-stats probe: .select("status").in("status", [...]) → empty
        return { select: () => ({ in: async () => ({ data: [], error: null }) }) };
      }
      if (table !== "inbound_emails") throw new Error(`unexpected table ${table}`);
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.order = () => q;
      q.limit = async () => ({ data: result.data ?? [], error: result.error ?? null });
      return q;
    },
  };
}

const INBOUND_DB_ROW = {
  id: "44444444-4444-4444-8444-444444444444",
  message_id: "<msg-1@example.com>",
  from_email: "customer@example.com",
  to_address: "support@zapnivo.com",
  subject: "Re: ZN-1042",
  ticket_number: "ZN-1042",
  status: "accepted",
  reason: null,
  auth_method: "reply_token",
  dmarc_result: "pass",
  spf_result: "pass",
  dkim_result: "pass",
  body_preview: "Thanks, that fixed it.",
  processed_ms: 42,
  created_at: "2026-11-08T10:00:00Z",
};

describe("inbound email API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceClientMock.mockReturnValue(dbWithInbound({ data: [INBOUND_DB_ROW] }));
  });

  it("401 anon, 403 customer, 200 staff", async () => {
    session.mockResolvedValueOnce(null);
    expect((await inboundGET()).status).toBe(401);
    session.mockResolvedValueOnce(CUSTOMER);
    expect((await inboundGET()).status).toBe(403);

    session.mockResolvedValueOnce(STAFF);
    const res = await inboundGET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.available).toBe(true);
    expect(data.emails).toHaveLength(1);
  });

  it("maps snake_case db rows to the safe StudioInboundRow shape", async () => {
    session.mockResolvedValue(STAFF);
    const data = await (await inboundGET()).json();
    expect(data.emails[0]).toMatchObject({
      id: INBOUND_DB_ROW.id,
      messageId: "<msg-1@example.com>",
      fromEmail: "customer@example.com",
      toAddress: "support@zapnivo.com",
      subject: "Re: ZN-1042",
      ticketNumber: "ZN-1042",
      status: "accepted",
      reason: null,
      authMethod: "reply_token",
      dmarcResult: "pass",
      spfResult: "pass",
      dkimResult: "pass",
      bodyPreview: "Thanks, that fixed it.",
      processedMs: 42,
      createdAt: "2026-11-08T10:00:00Z",
    });
    // No raw headers or full bodies leak through.
    expect(JSON.stringify(data.emails[0])).not.toContain("headers");
  });

  it("reports available:false when the query errors", async () => {
    session.mockResolvedValue(STAFF);
    serviceClientMock.mockReturnValue(dbWithInbound({ data: null, error: { message: "relation inbound_emails does not exist" } }));
    const res = await inboundGET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.available).toBe(false);
    expect(data.emails).toEqual([]);
    expect(data.note).toBeTruthy();
  });

  it("reports available:false when the service client isn't configured", async () => {
    session.mockResolvedValue(STAFF);
    serviceClientMock.mockReturnValue(null);
    const res = await inboundGET();
    const data = await res.json();
    expect(data.available).toBe(false);
    expect(data.emails).toEqual([]);
  });
});

describe("inbound status helpers", () => {
  it("labels known statuses and passes unknowns through", () => {
    expect(inboundStatusLabel("accepted")).toBe("Accepted");
    expect(inboundStatusLabel("quarantined")).toBe("Quarantined");
    expect(inboundStatusLabel("some_future_status")).toBe("some_future_status");
  });

  it("counts rows by status", () => {
    const counts = inboundStatusCounts([
      { status: "accepted" }, { status: "accepted" }, { status: "quarantined" }, { status: "error" },
    ]);
    expect(counts).toEqual({ accepted: 2, quarantined: 1, error: 1 });
  });
});

describe("outbox log API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoHolder.repo = new MemoryRepo();
    serviceClientMock.mockReturnValue(dbWithStaff(["agent@zapnivo.com"]));
  });

  it("401 anon, 403 customer, 200 staff", async () => {
    session.mockResolvedValueOnce(null);
    expect((await logGET()).status).toBe(401);
    session.mockResolvedValueOnce(CUSTOMER);
    expect((await logGET()).status).toBe(403);
    session.mockResolvedValueOnce(STAFF);
    expect((await logGET()).status).toBe(200);
  });

  it("returns queued/sent/failed rows with sender names, newest first", async () => {
    session.mockResolvedValue(STAFF);
    const repo = repoHolder.repo as MemoryRepo;
    await repo.queueEmail({ ticketId: null, to: "a@zapnivo.com", subject: "One", body: "b", html: null, sender: "support", template: "support_created", event: "support.ticket.created" });
    await repo.queueEmail({ ticketId: null, to: "b@zapnivo.com", subject: "Two", body: "b", html: null });
    await repo.markEmail((await repo.listEmails())[0].id, "sent");

    const res = await logGET();
    const data = await res.json();
    expect(data.available).toBe(true);
    expect(data.emails).toHaveLength(2);
    // Rows are ordered newest-first by createdAt (same-ms ties keep insertion order).
    expect(data.emails.map((e: { subject: string }) => e.subject).sort()).toEqual(["One", "Two"]);
    const first = data.emails.find((e: { subject: string }) => e.subject === "One");
    expect(first.status).toBe("sent");
    expect(first.sender).toBe("support");
    expect(first.senderName).toBe(EMAIL_SENDERS.support.name);
    expect(first.event).toBe("support.ticket.created");
    expect(first.template).toBe("support_created");
  });

  it("reports an honest empty state when the repo is unavailable", async () => {
    session.mockResolvedValue(STAFF);
    repoHolder.repo = null;
    const res = await logGET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.available).toBe(false);
    expect(data.emails).toEqual([]);
    expect(data.note).toBeTruthy();
  });
});
