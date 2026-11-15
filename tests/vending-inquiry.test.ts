import { beforeEach, describe, expect, it, vi } from "vitest";

const { serviceClient } = vi.hoisted(() => ({ serviceClient: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ serviceClient }));
vi.mock("@/lib/helpdesk/repo", () => ({ getRepo: async () => null }));
vi.mock("@/lib/helpdesk/mailer", () => ({ getMailer: () => null, flushOutbox: async () => {} }));
vi.mock("@/lib/email-extra-triggers", () => ({ triggerVendingInquiryReceived: vi.fn(async () => true) }));

import { POST } from "@/app/api/vending-inquiries/route";
import { resetRateLimits } from "@/lib/rate-limit";
import { vendingInquirySchema } from "@/lib/validation";

/* ── Schema ─────────────────────────────────────────────────────────────── */

const good = {
  businessName: "Stumptown Coffee", contactName: "Ada Lovelace", email: "ADA@Example.com", phone: "+1 206-555-0100",
  address: "1 Pine St", city: "Seattle", state: "wa",
  venueCategory: "retail", guestTraffic: "200-1000",
  productInterest: "snack,beverage", spaceNotes: "4 ft counter near the door",
  timeline: "1-3mo", questions: "Do you service Washington?", consent: true,
};

describe("vendingInquirySchema", () => {
  it("accepts a complete inquiry and normalizes state/email", () => {
    const r = vendingInquirySchema.safeParse(good);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.state).toBe("WA");
      expect(r.data.email).toBe("ada@example.com");
      expect(r.data.productInterest).toBe("snack,beverage");
    }
  });
  it("accepts optional fields omitted or empty", () => {
    const { spaceNotes: _s, timeline: _t, questions: _q, guestTraffic: _g, ...required } = good;
    expect(vendingInquirySchema.safeParse({ ...required, productInterest: "general" }).success).toBe(true);
    expect(vendingInquirySchema.safeParse({ ...required, spaceNotes: "", timeline: "", questions: "", guestTraffic: "", productInterest: "general" }).success).toBe(true);
  });
  it("rejects unknown product interests, venue categories and timelines", () => {
    expect(vendingInquirySchema.safeParse({ ...good, productInterest: "plasma_tv" }).success).toBe(false);
    expect(vendingInquirySchema.safeParse({ ...good, productInterest: "snack,plasma_tv" }).success).toBe(false);
    expect(vendingInquirySchema.safeParse({ ...good, venueCategory: "castle" }).success).toBe(false);
    expect(vendingInquirySchema.safeParse({ ...good, timeline: "whenever" }).success).toBe(false);
  });
  it("requires consent and rejects filled honeypots / bad contact fields", () => {
    expect(vendingInquirySchema.safeParse({ ...good, consent: false }).success).toBe(false);
    expect(vendingInquirySchema.safeParse({ ...good, consent: "true" }).success).toBe(false);
    expect(vendingInquirySchema.safeParse({ ...good, website: "spam.biz" }).success).toBe(false);
    expect(vendingInquirySchema.safeParse({ ...good, email: "nope" }).success).toBe(false);
    expect(vendingInquirySchema.safeParse({ ...good, state: "WASH" }).success).toBe(false);
  });
});

/* ── Route ──────────────────────────────────────────────────────────────── */

function fakeDb() {
  const inserted: { table: string; row: Record<string, unknown> }[] = [];
  const db = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push({ table, row });
        return {
          select: () => ({
            single: async () => ({ data: { id: "00000000-0000-4000-8000-00000000abcd", ticket_number: null }, error: null }),
          }),
        };
      },
    }),
  };
  return { db, inserted };
}

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/vending-inquiries", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

beforeEach(() => {
  resetRateLimits();
  serviceClient.mockReset();
});

describe("POST /api/vending-inquiries", () => {
  it("503s honestly when Supabase is not configured", async () => {
    serviceClient.mockReturnValue(null);
    const res = await post(good);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("backend_unconfigured");
  });

  it("422s on invalid payloads", async () => {
    serviceClient.mockReturnValue(fakeDb().db);
    const res = await post({ ...good, consent: false });
    expect(res.status).toBe(422);
    const res2 = await post({ businessName: "x" });
    expect(res2.status).toBe(422);
  });

  it("inserts into partner_applications with the vending column mapping", async () => {
    const { db, inserted } = fakeDb();
    serviceClient.mockReturnValue(db);
    const res = await post(good);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    // Telemetry (app_logs, business_events) also writes through the same client — filter to the CRM table.
    const apps = inserted.filter((i) => i.table === "partner_applications");
    expect(apps).toHaveLength(1);
    const row = apps[0].row;
    expect(row).toMatchObject({
      business_name: "Stumptown Coffee",
      contact_name: "Ada Lovelace",
      email: "ada@example.com",
      venue_type: "Retail store",
      street: "1 Pine St",
      city: "Seattle",
      state: "WA",
      guest_traffic: "200–1,000 guests/day",
      product_interest: "snack,beverage",
      space_notes: "4 ft counter near the door",
      timeline: "1–3 months",
      questions: "Do you service Washington?",
    });
    // consent + honeypot must never reach the DB
    expect(row).not.toHaveProperty("consent");
    expect(row).not.toHaveProperty("website");
  });

  it("silently accepts honeypot submissions without inserting", async () => {
    const { db, inserted } = fakeDb();
    serviceClient.mockReturnValue(db);
    const apps = () => inserted.filter((i) => i.table === "partner_applications");
    // Empty-string honeypot passes schema; a filled one is rejected by max(0).
    const res = await post({ ...good, website: "" });
    expect(res.status).toBe(200);
    expect(apps()).toHaveLength(1);
    const filled = await post({ ...good, website: "spam.biz" });
    expect(filled.status).toBe(422);
    expect(apps()).toHaveLength(1);
  });
});
