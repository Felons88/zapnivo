import { describe, expect, it } from "vitest";
import { contactSchema, looksLikeCardNumber, partnerApplicationSchema, ticketSchema } from "@/lib/validation";

describe("partnerApplicationSchema", () => {
  const good = {
    businessName: "Riverside Tavern", contactName: "Sam Roe", email: "sam@example.com", phone: "+1 320-555-0199",
    venueType: "Bar", street: "10 Main St", city: "St. Cloud", state: "MN", hours: "11am-1am", installLocation: "Bar counter",
  };
  it("accepts a complete application", () => {
    expect(partnerApplicationSchema.safeParse(good).success).toBe(true);
  });
  it("rejects unknown venue types", () => {
    expect(partnerApplicationSchema.safeParse({ ...good, venueType: "Spaceship" }).success).toBe(false);
  });
  it("rejects bad email / phone / state", () => {
    expect(partnerApplicationSchema.safeParse({ ...good, email: "nope" }).success).toBe(false);
    expect(partnerApplicationSchema.safeParse({ ...good, phone: "call me" }).success).toBe(false);
    expect(partnerApplicationSchema.safeParse({ ...good, state: "MIN" }).success).toBe(false);
  });
  it("rejects filled honeypots", () => {
    expect(partnerApplicationSchema.safeParse({ ...good, website: "spammy.biz" }).success).toBe(false);
  });
});

describe("contactSchema", () => {
  it("routes only known topics", () => {
    const base = { name: "A", email: "a@b.co", message: "hi" };
    expect(contactSchema.safeParse({ ...base, topic: "advertising" }).success).toBe(true);
    expect(contactSchema.safeParse({ ...base, topic: "ceo" }).success).toBe(false);
  });
});

describe("ticketSchema", () => {
  const good = { name: "Pat", email: "p@x.io", category: "Billing question", description: "My return was not recognized by the station.", consent: true };
  it("requires consent and a real description", () => {
    expect(ticketSchema.safeParse(good).success).toBe(true);
    expect(ticketSchema.safeParse({ ...good, consent: false }).success).toBe(false);
    expect(ticketSchema.safeParse({ ...good, description: "bad" }).success).toBe(false);
  });
});

describe("looksLikeCardNumber", () => {
  it("flags card-like sequences", () => {
    expect(looksLikeCardNumber("4242 4242 4242 4242")).toBe(true);
    expect(looksLikeCardNumber("4242-4242-4242-4242")).toBe(true);
    expect(looksLikeCardNumber("call me at 320-5550")).toBe(false);
  });
});
