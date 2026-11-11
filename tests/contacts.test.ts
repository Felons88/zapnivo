import { describe, expect, it } from "vitest";
import { CONTACTS, isPublicContact, type ContactKey } from "@/lib/contacts";
import { EMAIL_SENDERS, type EmailSenderId } from "@/lib/email/senders";

const EXPECTED: Record<ContactKey, { email: string; senderId: EmailSenderId; kind: string }> = {
  general: { email: "hello@zapnivo.com", senderId: "general", kind: "public_contact" },
  support: { email: "support@zapnivo.com", senderId: "support", kind: "support" },
  partners: { email: "partners@zapnivo.com", senderId: "partners", kind: "partnership" },
  billing: { email: "billing@zapnivo.com", senderId: "billing", kind: "billing" },
  security: { email: "security@zapnivo.com", senderId: "security", kind: "security" },
};

describe("contact registry", () => {
  it("contains exactly the five verified public contacts", () => {
    expect(Object.keys(CONTACTS).sort()).toEqual(["billing", "general", "partners", "security", "support"]);
  });

  it("every contact email exists in EMAIL_SENDERS — the registry can't drift", () => {
    for (const [key, want] of Object.entries(EXPECTED) as [ContactKey, (typeof EXPECTED)[ContactKey]][]) {
      const c = CONTACTS[key];
      expect(c.email).toBe(want.email);
      expect(c.email).toBe(EMAIL_SENDERS[c.senderId].email);
      expect(c.senderId).toBe(want.senderId);
      expect(c.kind).toBe(want.kind);
      expect(c.email).toMatch(/@zapnivo\.com$/);
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.outboundSender).toBe(true);
      expect(c.monitored).toBe(true);
    }
  });

  it("does not list noreply or other non-contact sender addresses", () => {
    const emails = Object.values(CONTACTS).map((c) => c.email);
    expect(emails).not.toContain(EMAIL_SENDERS.noreply.email);
    expect(emails).not.toContain(EMAIL_SENDERS.rentals.email);
    expect(emails).not.toContain(EMAIL_SENDERS.admin.email);
    expect(emails).not.toContain(EMAIL_SENDERS.legal.email);
  });
});

describe("isPublicContact", () => {
  it("accepts registry addresses case-insensitively with whitespace", () => {
    expect(isPublicContact("hello@zapnivo.com")).toBe(true);
    expect(isPublicContact("  SUPPORT@Zapnivo.COM ")).toBe(true);
    expect(isPublicContact("security@zapnivo.com")).toBe(true);
  });

  it("rejects non-registry and malformed input", () => {
    expect(isPublicContact("noreply@zapnivo.com")).toBe(false);
    expect(isPublicContact("billing@zapnivo.com.evil.com")).toBe(false);
    expect(isPublicContact("someone@gmail.com")).toBe(false);
    expect(isPublicContact("")).toBe(false);
    expect(isPublicContact(null)).toBe(false);
    expect(isPublicContact(undefined)).toBe(false);
  });
});
