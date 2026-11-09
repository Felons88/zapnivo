import { devStoreEnabled } from "./repo";
import type { RentalRow } from "../rental-lookup";
import { serviceClient } from "../supabase";

/** STAFF-side rental lookup by reference (no customer email needed). Never exposed to the public. */
export interface RentalDirectory {
  byReference(ref: string): Promise<RentalRow | null>;
}

export class SupabaseRentalDirectory implements RentalDirectory {
  async byReference(ref: string): Promise<RentalRow | null> {
    const db = serviceClient();
    if (!db) return null;
    const { data } = await db
      .from("rentals")
      .select("reference,state,started_at,dispensed_at,returned_at,non_return_deadline,kiosks!rentals_kiosk_id_fkey(station_id,venues(name,city)),payments(state,amount_captured_cents,amount_refunded_cents,stripe_payment_intent_id)")
      .eq("reference", ref.toUpperCase())
      .maybeSingle();
    return (data as unknown as RentalRow) ?? null;
  }
}

/** Dev store only: clearly labelled DEMO rentals so the refund workflow can be tried end-to-end. */
const DEMO: Record<string, RentalRow> = {
  "ZR-DEMO0001": { reference: "ZR-DEMO0001", state: "authorized", started_at: "2026-11-07T01:10:00Z", dispensed_at: null, returned_at: null, non_return_deadline: null, kiosks: { station_id: "DEMO-01", venues: { name: "Demo Tavern", city: "Demoville" } }, payments: [{ state: "captured", amount_captured_cents: 699, amount_refunded_cents: 0, stripe_payment_intent_id: "pi_demo_1" }] },
  "ZR-DEMO0002": { reference: "ZR-DEMO0002", state: "returned", started_at: "2026-11-07T00:00:00Z", dispensed_at: "2026-11-07T00:00:00Z", returned_at: "2026-11-07T02:30:00Z", non_return_deadline: null, kiosks: { station_id: "DEMO-01", venues: { name: "Demo Tavern", city: "Demoville" } }, payments: [{ state: "captured", amount_captured_cents: 1299, amount_refunded_cents: 0, stripe_payment_intent_id: "pi_demo_2" }] },
  "ZR-DEMO0003": { reference: "ZR-DEMO0003", state: "charged_off", started_at: "2026-11-01T00:00:00Z", dispensed_at: "2026-11-01T00:00:00Z", returned_at: null, non_return_deadline: "2026-11-04T00:00:00Z", kiosks: { station_id: "DEMO-02", venues: { name: "Demo Hotel", city: "Demoville" } }, payments: [{ state: "captured", amount_captured_cents: 4500, amount_refunded_cents: 0, stripe_payment_intent_id: "pi_demo_3" }] },
};
export class DemoRentalDirectory implements RentalDirectory {
  async byReference(ref: string) { return structuredClone(DEMO[ref.toUpperCase()] ?? null); }
}

export const getRentalDirectory = (): RentalDirectory => (devStoreEnabled() ? new DemoRentalDirectory() : new SupabaseRentalDirectory());
