import { describe, expect, it } from "vitest";
import { partnerApplicationSchema } from "@/lib/validation";
import {
  APPLICATION_SCHEMA,
  GUEST_RENTAL_FACTS,
  NEXT_STEPS,
  RESPONSIBILITIES,
  STEP_FIELDS,
  STEP_LABELS,
  STEP_SCHEMAS,
  toApplicationInput,
  validateApplication,
  validateStep,
} from "@/app/(site)/business/apply/form";

const good = {
  businessName: "Riverside Tavern",
  contactName: "Sam Roe",
  email: "sam@example.com",
  phone: "+1 320-555-0199",
  venueType: "Bar",
  street: "10 Main St",
  city: "St. Cloud",
  state: "MN",
  hours: "",
  guestTraffic: "",
  installLocation: "",
  questions: "",
  website: "",
};

describe("application form field coverage", () => {
  it("step fields cover every schema key except the honeypot", () => {
    const schemaKeys = Object.keys(partnerApplicationSchema.shape).filter((k) => k !== "website");
    const formKeys = STEP_FIELDS.flat();
    expect([...formKeys].sort()).toEqual([...schemaKeys].sort());
    expect(formKeys).not.toContain("website");
  });

  it("has one label and one step schema per step", () => {
    expect(STEP_LABELS).toHaveLength(STEP_FIELDS.length);
    expect(STEP_SCHEMAS).toHaveLength(STEP_FIELDS.length);
  });

  it("client schema accepts a complete application and rejects a filled honeypot upstream", () => {
    expect(APPLICATION_SCHEMA.safeParse(toApplicationInput(good)).success).toBe(true);
    // honeypot stays server-side: client schema ignores it entirely
    expect(APPLICATION_SCHEMA.safeParse({ ...toApplicationInput(good), website: "spam.biz" }).success).toBe(true);
    expect(partnerApplicationSchema.safeParse({ ...good, website: "spam.biz" }).success).toBe(false);
  });
});

describe("validateStep", () => {
  it("passes a valid step 0", () => {
    expect(validateStep(good, 0)).toBeNull();
  });

  it("flags bad email and phone with readable messages", () => {
    const errors = validateStep({ ...good, email: "nope", phone: "call me" }, 0)!;
    expect(errors.email).toBeTruthy();
    expect(errors.phone).toBe("Enter a valid phone number");
  });

  it("flags a bad venue type and short state on step 1", () => {
    const errors = validateStep({ ...good, venueType: "Spaceship", state: "M" }, 1)!;
    expect(errors.venueType).toBeTruthy();
    expect(errors.state).toBeTruthy();
  });

  it("step 2 is all-optional and always valid", () => {
    expect(validateStep(good, 2)).toBeNull();
  });
});

describe("validateApplication", () => {
  it("returns no errors and step -1 for valid data", () => {
    const result = validateApplication(good);
    expect(result.errors).toEqual({});
    expect(result.step).toBe(-1);
  });

  it("points back to the earliest step with an invalid field", () => {
    const result = validateApplication({ ...good, email: "bad", state: "Minnesota" });
    expect(result.step).toBe(0);
    expect(result.errors.email).toBeTruthy();
    expect(result.errors.state).toBeTruthy();
  });

  it("handles a step-1-only failure", () => {
    const result = validateApplication({ ...good, city: "" });
    expect(result.step).toBe(1);
    expect(result.errors.city).toBeTruthy();
  });
});

describe("honest partner copy", () => {
  const allCopy = [...NEXT_STEPS.map((s) => `${s.title} ${s.body}`), ...RESPONSIBILITIES.map((r) => `${r.who} ${r.items}`)].join(" ");

  it("never invents a revenue-share percentage or guarantee", () => {
    expect(allCopy).not.toMatch(/\d+\s*%/);
    expect(allCopy).not.toMatch(/guarantee[sd]?\s+(placement|revenue|income)/i);
    expect(allCopy).toMatch(/agreement/i);
  });

  it("guest rental facts match confirmed pricing", () => {
    expect(GUEST_RENTAL_FACTS).toContain("$6.99 per started hour");
    expect(GUEST_RENTAL_FACTS).toContain("24-hour return window");
    expect(GUEST_RENTAL_FACTS).toContain("$45 non-return fee");
  });
});
