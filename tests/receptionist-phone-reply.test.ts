import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  sendSms: vi.fn(),
  serviceClient: vi.fn(),
  auditLog: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ getSessionUser: async () => ({ id: "staff-1", role: "staff", email: "agent@zapnivo.com" }), isStaff: () => true }));
vi.mock("@/lib/supabase", () => ({ serviceClient: mocked.serviceClient }));
vi.mock("@/lib/sms", () => ({
  normalizePhone: (value: string) => /^\+1\d{10}$/.test(value) ? value : null,
  smsConfigured: () => true,
  sendSms: mocked.sendSms,
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock("@/lib/audit", () => ({ auditLog: mocked.auditLog }));

import { POST } from "@/app/api/admin/receptionist/phone/reply/route";

function db({ inbound = true, optedOut = false, optOutError = false }: { inbound?: boolean; optedOut?: boolean; optOutError?: boolean } = {}) {
  return {
    from(table: string) {
      const query = {
        select: () => query,
        eq: () => query,
        limit: async () => ({ data: table === "sms_messages" && inbound ? [{ id: "message-1" }] : [], error: null }),
        maybeSingle: async () => ({ data: optedOut ? { phone: "+15551234567" } : null, error: optOutError ? { message: "unavailable" } : null }),
      };
      return query;
    },
  };
}

function request() {
  const form = new FormData();
  form.set("phone", "+15551234567");
  form.set("body", "We can help with that.");
  return new Request("http://localhost/api/admin/receptionist/phone/reply", { method: "POST", body: form });
}

describe("staff phone replies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.sendSms.mockResolvedValue({ sent: true });
  });
  it("requires an existing inbound message", async () => {
    mocked.serviceClient.mockReturnValue(db({ inbound: false }));
    const res = await POST(request());
    expect(res.status).toBe(403);
    expect(mocked.sendSms).not.toHaveBeenCalled();
  });
  it("fails closed when opt-out status is unavailable", async () => {
    mocked.serviceClient.mockReturnValue(db({ optOutError: true }));
    const res = await POST(request());
    expect(res.status).toBe(503);
    expect(mocked.sendSms).not.toHaveBeenCalled();
  });
  it("does not text a contact who opted out", async () => {
    mocked.serviceClient.mockReturnValue(db({ optedOut: true }));
    const res = await POST(request());
    expect(res.status).toBe(403);
    expect(mocked.sendSms).not.toHaveBeenCalled();
  });
  it("sends and audits a reply to an inbound contact", async () => {
    mocked.serviceClient.mockReturnValue(db());
    const res = await POST(request());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("result=sent");
    expect(mocked.sendSms).toHaveBeenCalledWith(expect.anything(), { to: "+15551234567", body: "We can help with that." });
    expect(mocked.auditLog).toHaveBeenCalledOnce();
  });
});
