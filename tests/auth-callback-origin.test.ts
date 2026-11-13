import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authCallbackOrigin } from "../src/lib/auth-callback-origin";

const request = (host: string, path = "/api/auth/google") =>
  new NextRequest(`https://${host}${path}`, { headers: { host } });

describe("auth callback host trust", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts exact public and portal hosts over HTTPS in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const host of ["www.zapnivo.com", "zapnivo.com", "support.zapnivo.com", "customer.zapnivo.com", "partners.zapnivo.com", "internal.zapnivo.com", "api.zapnivo.com"]) {
      expect(authCallbackOrigin(request(host))).toBe(`https://${host}`);
    }
  });

  it("accepts only the exact configured Vercel preview host", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_URL", "zapnivo-git-feature-team.vercel.app");
    expect(authCallbackOrigin(request("zapnivo-git-feature-team.vercel.app"))).toBe("https://zapnivo-git-feature-team.vercel.app");
    expect(authCallbackOrigin(request("attacker.vercel.app"))).toBeNull();
  });

  it("rejects lookalike, arbitrary and port-bearing production hosts", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const host of ["evil.example", "www.zapnivo.com.evil.example", "unknown.zapnivo.com", "www.zapnivo.com:3000"]) {
      expect(authCallbackOrigin(request(host))).toBeNull();
    }
  });

  it("keeps localhost callback cookies on the same development host", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(authCallbackOrigin(new NextRequest("http://customer.localhost:3000/api/auth/google", { headers: { host: "customer.localhost:3000" } })))
      .toBe("http://customer.localhost:3000");
  });

  it("blocks forged hosts before each sign-in route starts", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { GET: google } = await import("../src/app/api/auth/google/route");
    const { POST: email } = await import("../src/app/api/auth/email-link/route");
    const { POST: phone } = await import("../src/app/api/auth/phone/route");
    const { GET: callback } = await import("../src/app/api/auth/callback/route");
    expect((await google(request("evil.example"))).status).toBe(403);
    expect((await email(new NextRequest("https://evil.example/api/auth/email-link", { method: "POST", headers: { host: "evil.example", "content-type": "application/json" }, body: JSON.stringify({ email: "customer@example.com" }) }))).status).toBe(403);
    expect((await phone(new NextRequest("https://evil.example/api/auth/phone", { method: "POST", headers: { host: "evil.example", "content-type": "application/json" }, body: JSON.stringify({ action: "send", phone: "+12125550123" }) }))).status).toBe(403);
    expect((await callback(request("evil.example", "/api/auth/callback?code=forged"))).status).toBe(403);
    // Dynamic route imports pull in next/server + supabase clients — slow under
    // full-suite parallel load on network filesystems.
  }, 30_000);
});
