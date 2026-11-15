/**
 * Equipment categories added by migration 0070 (venues.equipment_category,
 * kiosks.equipment_category). NULL/empty means "not classified" — existing
 * charger kiosks keep working unchanged and are the legacy charger fleet.
 */
export const EQUIPMENT_CATEGORIES = ["charger_station", "snack", "beverage", "food", "trading_cards", "specialty"] as const;
export type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number];

export const EQUIPMENT_LABELS: Record<EquipmentCategory, string> = {
  charger_station: "Charger station",
  snack: "Snack vending",
  beverage: "Beverage vending",
  food: "Food vending",
  trading_cards: "Trading cards / collectibles",
  specialty: "Specialty",
};

export const UNCLASSIFIED_LABEL = "Unclassified";

/** Legacy kiosks with no category are charger stations; venues stay "Unclassified". */
export const KIOSK_DEFAULT_CATEGORY: EquipmentCategory = "charger_station";

export const isEquipmentCategory = (v: string): v is EquipmentCategory =>
  (EQUIPMENT_CATEGORIES as readonly string[]).includes(v);

/** Human label for a stored category. null/empty -> null; unknown non-empty values pass through. */
export function equipmentLabel(category: string | null | undefined): string | null {
  const c = category?.trim();
  if (!c) return null;
  return isEquipmentCategory(c) ? EQUIPMENT_LABELS[c] : c;
}

/** Label with an explicit fallback used when the column is empty. */
export function equipmentLabelOr(category: string | null | undefined, fallback: "charger_station" | "unclassified"): string {
  return equipmentLabel(category) ?? (fallback === "charger_station" ? EQUIPMENT_LABELS[KIOSK_DEFAULT_CATEGORY] : UNCLASSIFIED_LABEL);
}
