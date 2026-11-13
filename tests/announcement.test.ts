import { describe, expect, it } from "vitest";
import { pickAnnouncement } from "@/components/Header";
import { flag, text, type PublishedContent } from "@/lib/site-content";

/**
 * Announcement selection for the (site) layout strip. The support host
 * (support.zapnivo.com) rewrites into /support/* under the same layout, so
 * Header chooses the banner by internal pathname — apex behavior unchanged.
 */

const apexBar = { text: "Apex announcement", href: "/about" };
const supportBar = { text: "Support announcement", href: "/support/new" };

describe("pickAnnouncement", () => {
  it("uses the apex announcement on apex paths", () => {
    for (const p of ["/", "/about", "/locations", "/contact", "/support"]) {
      // /support covered below — apex paths:
      if (p === "/support") continue;
      expect(pickAnnouncement(p, apexBar, supportBar), p).toEqual({ show: true, announcement: apexBar });
    }
  });

  it("prefers the support announcement under /support/* (support host rewrite surface)", () => {
    for (const p of ["/support", "/support/articles/x", "/support/new", "/support/ticket/123"]) {
      expect(pickAnnouncement(p, apexBar, supportBar), p).toEqual({ show: true, announcement: supportBar });
    }
  });

  it("falls back to the apex announcement on /support/* when support has none enabled", () => {
    expect(pickAnnouncement("/support", apexBar, null)).toEqual({ show: true, announcement: apexBar });
    expect(pickAnnouncement("/support/articles/x", null, null)).toEqual({ show: true, announcement: null });
  });

  it("does not leak the support announcement onto non-support paths", () => {
    expect(pickAnnouncement("/account", null, supportBar).announcement).toBeNull();
    expect(pickAnnouncement("/", null, supportBar).announcement).toBeNull();
    expect(pickAnnouncement("/supportx", apexBar, supportBar).announcement).toBe(apexBar);
  });

  it("suppresses the strip entirely on auth paths", () => {
    for (const p of ["/login", "/login/"]) {
      expect(pickAnnouncement(p, apexBar, supportBar), p).toEqual({ show: false, announcement: null });
    }
  });
});

describe("support/global content resolution", () => {
  it("reads announcement fields the same way apex/global does", () => {
    const cms: PublishedContent = { announcement_enabled: true, announcement_text: "Hi", announcement_href: "/x" };
    expect(flag(cms, "announcement_enabled", false)).toBe(true);
    expect(text(cms, "announcement_text", "")).toBe("Hi");
    // disabled / missing → falsy, layout passes null → apex fallback applies
    expect(flag({}, "announcement_enabled", false)).toBe(false);
    expect(flag({ announcement_enabled: "yes" }, "announcement_enabled", false)).toBe(false);
  });
});
