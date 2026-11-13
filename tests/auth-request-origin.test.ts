import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

/**
 * Origin-header enforcement on the auth POST/DELETE routes. These checks run
 * before any DB or Supabase work, so a rejected request never touches the backend.
 */
const req = (path: string, init: { method?: string; host?: string; origin?: string; body?: unknown } = {}) =>
  new NextRequest(`https://${init.host ?? "www.zapnivo.com"}${path}`, {
    method: init.method ?? "POST",
    headers: {
      host: init.host ?? "www.zapnivo.com",
      "content-type": "application/json",
      ...(init.origin !== undefined ? { origin: init.origin } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

describe("POST /api/auth/phone — Origin check", () => {
  const phoneBody = { action: "send", phone: "+12125550123" };

  it("rejects a cross-origin Origin header", async () => {
    const { POST } = await import("@/app/api/auth/phone/route");
    const res = await POST(req("/api/auth/phone", { host: "support.zapnivo.com", origin: "https://evil.example", body: phoneBody }));
    expect(res.status).toBe(403);
  });

  it("rejects a malformed Origin header instead of throwing", async () => {
    const { POST } = await import("@/app/api/auth/phone/route");
    const res = await POST(req("/api/auth/phone", { host: "support.zapnivo.com", origin: "null", body: phoneBody }));
    expect(res.status).toBe(403);
  });

  it("does not reject a same-origin Origin header", async () => {
    const { POST } = await import("@/app/api/auth/phone/route");
    const res = await POST(req("/api/auth/phone", { host: "support.zapnivo.com", origin: "https://support.zapnivo.com", body: phoneBody }));
    // Past the Origin check the route hits the backend — 503 unconfigured, never 403.
    expect(res.status).not.toBe(403);
  });
});

describe("POST /api/auth/login — Origin check", () => {
  const loginBody = { email: "customer@example.com", password: "hunter2" };

  it("rejects a cross-origin Origin header", async () => {
    const { POST } = await import("@/app/api/auth/login/route");
    const res = await POST(req("/api/auth/login", { origin: "https://evil.example", body: loginBody }));
    expect(res.status).toBe(403);
  });

  it("rejects a malformed Origin header instead of 500ing", async () => {
    const { POST } = await import("@/app/api/auth/login/route");
    const res = await POST(req("/api/auth/login", { origin: "null", body: loginBody }));
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/auth/login — Origin check", () => {
  it("rejects a cross-origin Origin header", async () => {
    const { DELETE } = await import("@/app/api/auth/login/route");
    const res = await DELETE(req("/api/auth/login", { method: "DELETE", origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });

  it("rejects a malformed Origin header", async () => {
    const { DELETE } = await import("@/app/api/auth/login/route");
    const res = await DELETE(req("/api/auth/login", { method: "DELETE", origin: "null" }));
    expect(res.status).toBe(403);
  });
});
