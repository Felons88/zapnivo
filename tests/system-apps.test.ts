import { describe, expect, it } from "vitest";
import { visibleSystemApps } from "../src/lib/system/apps";

describe("system application launcher visibility", () => {
  it("shows no applications without a system role or business staff role", () => {
    expect(visibleSystemApps(null, false)).toEqual([]);
  });

  it("shows business applications only to business staff", () => {
    const apps = visibleSystemApps(null, true);
    expect(apps.some((app) => app.id === "customer-care")).toBe(true);
    expect(apps.some((app) => app.id === "finance")).toBe(false);
    expect(visibleSystemApps(null, true, true).some((app) => app.id === "finance")).toBe(true);
    expect(apps.some((app) => app.href.startsWith("/system/"))).toBe(false);
  });

  it("shows technical applications according to server role", () => {
    const viewer = visibleSystemApps("viewer", false).map((app) => app.id);
    const hardware = visibleSystemApps("hardware", false).map((app) => app.id);
    expect(viewer).toContain("system-overview");
    expect(viewer).not.toContain("customer-care");
    expect(hardware).toContain("kiosk-ops");
    expect(hardware).not.toContain("observability");
  });
});
