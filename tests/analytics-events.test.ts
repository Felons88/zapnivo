import { describe, expect, it } from "vitest";
import {
  PUBLIC_EVENT_NAMES,
  isPublicEvent,
  sanitizeProps,
} from "@/lib/analytics";

describe("PUBLIC_EVENT_NAMES — vending funnel additions", () => {
  const VENDING_EVENTS = [
    "vending_category_view",
    "vending_cta_click",
    "machine_request_form_start",
    "machine_request_form_submitted",
    "equipment_inquiry_view",
  ] as const;

  it.each(VENDING_EVENTS)("accepts public event %s", (name) => {
    expect(PUBLIC_EVENT_NAMES).toContain(name);
    expect(isPublicEvent(name)).toBe(true);
  });

  it("keeps every pre-existing public event", () => {
    for (const name of [
      "page_view", "session_start", "partner_application_submitted",
      "rental_checkout_started", "support_ticket_created", "customer_feedback_submitted",
    ]) {
      expect(isPublicEvent(name)).toBe(true);
    }
  });

  it("still rejects server-only lifecycle events", () => {
    for (const name of [
      "rental_started", "rental_completed", "partner_application_approved",
      "ad_campaign_paid", "ad_impression_verified",
    ]) {
      expect(isPublicEvent(name)).toBe(false);
    }
  });
});

describe("sanitizeProps — PII still stripped for vending events", () => {
  it("drops PII-shaped keys and keeps safe scalars", () => {
    const clean = sanitizeProps({
      category: "snacks",
      location_slug: "downtown-cafe",
      step: 2,
      email: "jane@example.com",
      phone: "612-555-0100",
      company_name: "Acme",
      card_number: "4242424242424242",
      message_body: "please call me",
      consent: true,
    });
    expect(clean).toEqual({
      category: "snacks",
      location_slug: "downtown-cafe",
      step: 2,
      consent: true,
    });
  });

  it("caps prop count and rejects non-scalar values", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 20; i++) many[`prop_${i}`] = `v${i}`;
    const out = sanitizeProps({ ...many, nested: { a: 1 }, arr: [1, 2] });
    expect(Object.keys(out).length).toBeLessThanOrEqual(12);
    expect(out.nested).toBeUndefined();
    expect(out.arr).toBeUndefined();
  });
});
