import { describe, expect, it } from "vitest";
import { leadSourceTag } from "@/lib/lead-source";

describe("leadSourceTag", () => {
  it("passes through valid slug-style tags", () => {
    expect(leadSourceTag("industry_offices", "fallback")).toBe("industry_offices");
    expect(leadSourceTag("vending_snacks", "fallback")).toBe("vending_snacks");
    expect(leadSourceTag("Placement_Page-1", "fallback")).toBe("placement_page-1");
  });

  it("falls back on missing, empty, or unsafe input", () => {
    expect(leadSourceTag(undefined, "fb")).toBe("fb");
    expect(leadSourceTag("", "fb")).toBe("fb");
    expect(leadSourceTag("!!!", "fb")).toBe("fb");
    expect(leadSourceTag("1leading-digit", "fb")).toBe("fb");
    expect(leadSourceTag(["a", "b"], "fb")).toBe("a");
  });

  it("strips unsafe characters and truncates", () => {
    expect(leadSourceTag("industry offices<script>", "fb")).toBe("industryofficesscript");
    expect(leadSourceTag("x".repeat(200), "fb")).toHaveLength(80);
  });
});
