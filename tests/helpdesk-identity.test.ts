import { describe, expect, it } from "vitest";
import { supportIdentity } from "../src/lib/helpdesk/identity";

describe("customer-facing support identity", () => {
  it("shows a complete profile name and the assigned support title", () => {
    expect(supportIdentity({ full_name: " James   Hewitt ", role: "staff", support_title: "manager" })).toBe("James Hewitt · Manager");
    expect(supportIdentity({ full_name: "Taylor Reed", role: "staff", support_title: "support_agent" })).toBe("Taylor Reed · Support agent");
  });

  it("uses the account role when a title has not been set", () => {
    expect(supportIdentity({ full_name: "James Hewitt", role: "admin" })).toBe("James Hewitt · Manager");
    expect(supportIdentity({ full_name: "Taylor Reed", role: "staff" })).toBe("Taylor Reed · Support agent");
  });

  it("never displays an incomplete name or email slug", () => {
    expect(supportIdentity({ full_name: "James312", role: "staff" })).toBe("Zapnivo Support · Support agent");
    expect(supportIdentity(null)).toBe("Zapnivo Support · Support agent");
  });
});
