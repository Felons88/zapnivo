import { describe, expect, it } from "vitest";
import { fingerprint, scrub, scrubAttrs } from "@/lib/observability";

describe("scrub", () => {
  it("redacts emails, phones, keys and card numbers", () => {
    const s = scrub("user bob@example.com called 555-123-4567 card 4111 1111 1111 1111 key sk-abcdef123456");
    expect(s).not.toContain("bob@example.com");
    expect(s).not.toContain("555-123-4567");
    expect(s).not.toContain("4111");
    expect(s).not.toContain("sk-abcdef");
  });
  it("truncates long input", () => {
    expect(scrub("x".repeat(9000), 100)).toHaveLength(100);
  });
});

describe("scrubAttrs", () => {
  it("drops sensitive keys and non-scalars", () => {
    const out = scrubAttrs({ route: "/admin", api_key: "sekret", nested: { a: 1 }, ok: 42, flag: true });
    expect(out).toEqual({ route: "/admin", ok: 42, flag: true });
  });
});

describe("fingerprint", () => {
  const stack = "Error: boom\n    at handler (src/app/api/x/route.ts:10:5)\n    at node_modules/x/y.js:1:1";
  it("is stable for the same error+route", () => {
    const a = fingerprint({ name: "Error", message: "boom", stack, route: "/api/x" });
    const b = fingerprint({ name: "Error", message: "boom", stack, route: "/api/x" });
    expect(a).toBe(b);
    expect(a).toHaveLength(24);
  });
  it("differs across routes and messages", () => {
    const a = fingerprint({ name: "Error", message: "boom", stack, route: "/api/x" });
    const b = fingerprint({ name: "Error", message: "boom", stack, route: "/api/y" });
    const c = fingerprint({ name: "TypeError", message: "boom", stack, route: "/api/x" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
