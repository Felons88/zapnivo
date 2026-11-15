import { describe, expect, it } from "vitest";
import {
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_LABELS,
  KIOSK_DEFAULT_CATEGORY,
  UNCLASSIFIED_LABEL,
  equipmentLabel,
  equipmentLabelOr,
  isEquipmentCategory,
} from "../src/lib/equipment";

describe("equipment categories", () => {
  it("lists every category exactly once with a label each", () => {
    expect(new Set(EQUIPMENT_CATEGORIES).size).toBe(EQUIPMENT_CATEGORIES.length);
    for (const c of EQUIPMENT_CATEGORIES) {
      expect(EQUIPMENT_LABELS[c]).toBeTruthy();
      expect(isEquipmentCategory(c)).toBe(true);
    }
  });

  it("covers the known categories", () => {
    expect([...EQUIPMENT_CATEGORIES].sort()).toEqual(
      ["beverage", "charger_station", "food", "snack", "specialty", "trading_cards"],
    );
  });
});

describe("equipmentLabel", () => {
  it("maps known categories to labels", () => {
    expect(equipmentLabel("charger_station")).toBe("Charger station");
    expect(equipmentLabel("snack")).toBe("Snack vending");
    expect(equipmentLabel("trading_cards")).toBe("Trading cards / collectibles");
  });

  it("returns null for null, empty and whitespace", () => {
    expect(equipmentLabel(null)).toBeNull();
    expect(equipmentLabel(undefined)).toBeNull();
    expect(equipmentLabel("")).toBeNull();
    expect(equipmentLabel("   ")).toBeNull();
  });

  it("passes through unknown non-empty values", () => {
    expect(equipmentLabel("custom_fridge")).toBe("custom_fridge");
  });
});

describe("equipmentLabelOr", () => {
  it("treats null kiosk categories as the legacy charger fleet", () => {
    expect(equipmentLabelOr(null, "charger_station")).toBe("Charger station");
    expect(equipmentLabelOr(undefined, "charger_station")).toBe("Charger station");
    expect(equipmentLabelOr("snack", "charger_station")).toBe("Snack vending");
  });

  it("treats null venue categories as unclassified", () => {
    expect(equipmentLabelOr(null, "unclassified")).toBe(UNCLASSIFIED_LABEL);
    expect(equipmentLabelOr("", "unclassified")).toBe(UNCLASSIFIED_LABEL);
    expect(equipmentLabelOr("beverage", "unclassified")).toBe("Beverage vending");
  });

  it("defaults kiosks to charger_station", () => {
    expect(KIOSK_DEFAULT_CATEGORY).toBe("charger_station");
  });
});
