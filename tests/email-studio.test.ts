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
import { EMAIL_AUDIENCES, EMAIL_TEMPLATES, getEmailTemplate, htmlToText, renderStudioTemplate } from "@/lib/email-studio";
import { MemoryRepo } from "@/lib/helpdesk/memory-repo";

const ADMIN = { id: "11111111-1111-4111-8111-111111111111", email: "admin@zapnivo.com", role: "admin", organizationId: null };
const STAFF = { id: "22222222-2222-4222-8222-222222222222", email: "agent@zapnivo.com", role: "staff", organizationId: null };
const CUSTOMER = { id: "33333333-3333-4333-8333-333333333333", email: "customer@example.com", role: "customer", organizationId: null };

const post = (url: string, payload: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

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
});
