import { describe, expect, it, vi } from "vitest";

// Keep the route test hermetic: never touch a real Supabase project.
vi.mock("@/lib/supabase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase")>()),
  serviceClient: () => null,
}));

import { POST } from "@/app/api/scam-reports/route";
import {
  formatReportMessage,
  REPORT_ANON_EMAIL,
  REPORT_KIND,
  scamReportSchema,
  type ScamReport,
} from "@/lib/scam-report";
import { sanitizeNextPath } from "@/lib/next-param";
import { resetRateLimits } from "@/lib/rate-limit";

const good: ScamReport = {
  category: "suspicious_email",
  description: "Got an email claiming my rental was held and asking me to verify my account via a link.",
  sender_or_url: "billing@zapnivo-support.com",
  occurred_on: "2025-01-15",
  contact_email: "Reporter@Example.com",
  station_id: "ZN-0042",
  website: undefined,
};

const req = (body: unknown, ip: string, contentType = "application/json") =>
  new Request("http://localhost/api/scam-reports", {
    method: "POST",
    headers: { "content-type": contentType, "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("scamReportSchema", () => {
  it("accepts a complete valid report", () => {
    const r = scamReportSchema.safeParse(good);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.contact_email).toBe("reporter@example.com");
  });

  it("accepts a minimal report (only category + description)", () => {
    expect(scamReportSchema.safeParse({ category: "other", description: "Something felt off." }).success).toBe(true);
  });

  it("rejects bad category, short/long description, bad email, bad date", () => {
    expect(scamReportSchema.safeParse({ ...good, category: "spam" }).success).toBe(false);
    expect(scamReportSchema.safeParse({ ...good, description: "short" }).success).toBe(false);
    expect(scamReportSchema.safeParse({ ...good, description: "x".repeat(4001) }).success).toBe(false);
    expect(scamReportSchema.safeParse({ ...good, contact_email: "not-an-email" }).success).toBe(false);
    expect(scamReportSchema.safeParse({ ...good, occurred_on: "15/01/2025" }).success).toBe(false);
    expect(scamReportSchema.safeParse({ ...good, sender_or_url: "y".repeat(501) }).success).toBe(false);
  });

  it("rejects a filled honeypot", () => {
    expect(scamReportSchema.safeParse({ ...good, website: "spam.biz" }).success).toBe(false);
  });
});

describe("formatReportMessage", () => {
  it("writes a parseable kind header plus all provided fields", () => {
    const msg = formatReportMessage(scamReportSchema.parse(good));
    expect(msg).toContain(`[kind: ${REPORT_KIND}]`);
    expect(msg).toContain("category: suspicious_email");
    expect(msg).toContain("occurred_on: 2025-01-15");
    expect(msg).toContain("sender_or_url: billing@zapnivo-support.com");
    expect(msg).toContain("station_id: ZN-0042");
    expect(msg).toContain("contact_email: reporter@example.com");
    expect(msg).toContain("---");
  });

  it("omits absent optional fields", () => {
    const msg = formatReportMessage({ category: "other", description: "Just a note.", sender_or_url: undefined, station_id: undefined, website: undefined });
    expect(msg).not.toContain("occurred_on:");
    expect(msg).not.toContain("sender_or_url:");
    expect(msg).toContain(`[kind: ${REPORT_KIND}]`);
  });

  it("documents the anonymous-email sentinel", () => {
    expect(REPORT_ANON_EMAIL).toMatch(/@/);
  });
});

describe("POST /api/scam-reports", () => {
  it("rejects non-JSON bodies (multipart/attachments)", async () => {
    resetRateLimits();
    const res = await POST(req("not json", "10.0.0.1", "text/plain"));
    expect(res.status).toBe(400);
  });

  it("returns 422 with field errors for invalid payloads", async () => {
    resetRateLimits();
    const res = await POST(req({ category: "nope" }, "10.0.0.2"));
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.fields).toBeTruthy();
  });

  it("rejects filled honeypot fields like other public forms", async () => {
    resetRateLimits();
    const res = await POST(req({ ...good, website: "spam.biz" }, "10.0.0.3"));
    expect(res.status).toBe(422);
  });

  it("rate-limits after 5 submissions per 10 minutes", async () => {
    resetRateLimits();
    const ip = "10.9.9.9";
    for (let i = 0; i < 5; i++) {
      const res = await POST(req({ ...good, website: "bot" }, ip)); // honeypot → 422, still counts
      expect(res.status).toBe(422);
    }
    const res = await POST(req({ ...good, website: "bot" }, ip));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("returns an honest 503 (not fake success) when Supabase is unconfigured", async () => {
    resetRateLimits();
    const res = await POST(req(good, "10.0.0.4"));
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.code).toBe("backend_unconfigured");
    expect(data.error).toContain("@zapnivo.com");
  });
});

describe("sanitizeNextPath", () => {
  it("accepts safe same-origin paths", () => {
    expect(sanitizeNextPath("/account/gifts/claim?t=abc")).toBe("/account/gifts/claim?t=abc");
    expect(sanitizeNextPath("/account")).toBe("/account");
    expect(sanitizeNextPath("/")).toBe("/");
  });

  it("rejects absolute, protocol-relative, and api URLs", () => {
    expect(sanitizeNextPath("https://evil.com")).toBeNull();
    expect(sanitizeNextPath("//evil.com")).toBeNull();
    expect(sanitizeNextPath("/\\evil.com")).toBeNull();
    expect(sanitizeNextPath("/api/auth/callback")).toBeNull();
    expect(sanitizeNextPath("/api")).toBeNull();
    expect(sanitizeNextPath("javascript:alert(1)")).toBeNull();
    expect(sanitizeNextPath("")).toBeNull();
    expect(sanitizeNextPath(null)).toBeNull();
    expect(sanitizeNextPath(undefined)).toBeNull();
  });

  it("rejects control characters and over-long values", () => {
    expect(sanitizeNextPath("/account\nSet-Cookie: x")).toBeNull();
    expect(sanitizeNextPath(`/${"a".repeat(600)}`)).toBeNull();
  });
});
