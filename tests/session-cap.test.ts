import { describe, expect, it } from "vitest";
import { jwtIssuedAt, SESSION_MAX_AGE_MS } from "@/lib/auth";

const jwt = (iat: number) => `h.${Buffer.from(JSON.stringify({ iat })).toString("base64url")}.s`;

describe("24h absolute session cap", () => {
  it("reads iat from a JWT payload", () => {
    expect(jwtIssuedAt(jwt(1_700_000_000))).toBe(1_700_000_000_000);
  });
  it("returns null for malformed tokens", () => {
    expect(jwtIssuedAt("not-a-jwt")).toBeNull();
    expect(jwtIssuedAt("a.!!!.c")).toBeNull();
    expect(jwtIssuedAt("")).toBeNull();
  });
  it("cap is exactly 24 hours", () => {
    expect(SESSION_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
  it("expiry math: iat+24h boundary", () => {
    const iat = 1_700_000_000_000;
    expect(iat + SESSION_MAX_AGE_MS - Date.now()).toBeLessThan(0); // old token → expired
    const fresh = Math.floor(Date.now() / 1000);
    expect(Date.now() - jwtIssuedAt(jwt(fresh))! ).toBeLessThan(SESSION_MAX_AGE_MS);
  });
});
