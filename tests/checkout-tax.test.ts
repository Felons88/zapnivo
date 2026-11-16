import { afterEach, describe, expect, it } from "vitest";
import { applyCheckoutTax, taxEnabled } from "@/lib/stripe";

/** applyCheckoutTax: flat STRIPE_TAX_RATE_ID on line items wins; STRIPE_TAX_ENABLED=1 falls back to automatic tax. */

const KEYS = ["STRIPE_TAX_RATE_ID", "STRIPE_TAX_ENABLED"] as const;
const saved = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined) {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const k of KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

const session = (): Record<string, unknown> => ({
  line_items: [{ quantity: 1, price_data: { unit_amount: 500 } }, { quantity: 2, price_data: { unit_amount: 100 } }],
});

describe("applyCheckoutTax", () => {
  it("attaches the flat rate to every line item and skips automatic tax", () => {
    setEnv("STRIPE_TAX_RATE_ID", "txr_flat8");
    setEnv("STRIPE_TAX_ENABLED", "1");
    const body = session();
    applyCheckoutTax(body);
    for (const item of body.line_items as Record<string, unknown>[]) expect(item.tax_rates).toEqual(["txr_flat8"]);
    expect(body.automatic_tax).toBeUndefined();
    expect(taxEnabled()).toBe(true);
  });

  it("uses automatic tax when only STRIPE_TAX_ENABLED=1", () => {
    setEnv("STRIPE_TAX_RATE_ID", undefined);
    setEnv("STRIPE_TAX_ENABLED", "1");
    const body = session();
    applyCheckoutTax(body);
    expect(body.automatic_tax).toEqual({ enabled: true });
    for (const item of body.line_items as Record<string, unknown>[]) expect(item.tax_rates).toBeUndefined();
  });

  it("does nothing when neither is configured", () => {
    setEnv("STRIPE_TAX_RATE_ID", undefined);
    setEnv("STRIPE_TAX_ENABLED", undefined);
    const body = session();
    applyCheckoutTax(body);
    expect(body.automatic_tax).toBeUndefined();
    for (const item of body.line_items as Record<string, unknown>[]) expect(item.tax_rates).toBeUndefined();
    expect(taxEnabled()).toBe(false);
  });

  it("tolerates a body without line items", () => {
    setEnv("STRIPE_TAX_RATE_ID", "txr_x");
    const body: Record<string, unknown> = {};
    expect(() => applyCheckoutTax(body)).not.toThrow();
    expect(body.automatic_tax).toBeUndefined();
  });
});
