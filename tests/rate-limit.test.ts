import { describe, expect, it } from "vitest";
import { rateLimit, resetRateLimits } from "@/lib/rate-limit";

describe("rateLimit", () => {
  it("allows up to the limit then blocks with a retry-after", () => {
    resetRateLimits();
    for (let i = 0; i < 5; i++) expect(rateLimit("ip1", 5, 60_000).ok).toBe(true);
    const blocked = rateLimit("ip1", 5, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });
  it("scopes keys independently", () => {
    resetRateLimits();
    for (let i = 0; i < 5; i++) rateLimit("a", 5, 60_000);
    expect(rateLimit("b", 5, 60_000).ok).toBe(true);
  });
  it("frees slots after the window", () => {
    resetRateLimits();
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) rateLimit("x", 5, 60_000, now);
    expect(rateLimit("x", 5, 60_000, now + 61_000).ok).toBe(true);
  });
});
