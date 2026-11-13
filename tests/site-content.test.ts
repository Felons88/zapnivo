import { describe, expect, it } from "vitest";
import { getPublishedContent, isContentLive, text, flag } from "@/lib/site-content";

/**
 * Public read path tests. The service client is unconfigured under vitest
 * (no NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY), so
 * getPublishedContent must resolve to {} — the live-site fallback contract.
 */

describe("isContentLive — serving rules", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  it("published and draft-with-published-value stay live", () => {
    expect(isContentLive("published", null, now)).toBe(true);
    expect(isContentLive("draft", null, now)).toBe(true); // pending draft never unpublishes
  });
  it("scheduled goes live only when due", () => {
    expect(isContentLive("scheduled", "2026-01-01T13:00:00Z", now)).toBe(false);
    expect(isContentLive("scheduled", "2026-01-01T11:00:00Z", now)).toBe(true);
    expect(isContentLive("scheduled", "not-a-date", now)).toBe(false);
    expect(isContentLive("scheduled", null, now)).toBe(false);
  });
  it("unknown statuses are never live", () => {
    expect(isContentLive("archived", null, now)).toBe(false);
    expect(isContentLive(undefined, null, now)).toBe(false);
  });
});

describe("getPublishedContent fallback contract", () => {
  it("resolves to {} without a configured backend — never throws", async () => {
    const out = await getPublishedContent("apex", "home");
    expect(out).toEqual({});
  });
  it("unknown site/page keys also resolve safely", async () => {
    await expect(getPublishedContent("not-a-site", "not-a-page")).resolves.toEqual({});
  });
});

describe("field helpers", () => {
  it("text() returns string values or the fallback", () => {
    expect(text({ a: "hello" }, "a", "fb")).toBe("hello");
    expect(text({ a: "" }, "a", "fb")).toBe("fb");
    expect(text({ a: 42 }, "a", "fb")).toBe("fb");
    expect(text({}, "missing", "fb")).toBe("fb");
  });
  it("flag() returns booleans or the fallback", () => {
    expect(flag({ b: true }, "b", false)).toBe(true);
    expect(flag({ b: "yes" }, "b", false)).toBe(false);
    expect(flag({}, "b", true)).toBe(true);
  });
});
