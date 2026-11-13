import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanApiRoutes, guessAuth } from "@/lib/system/api-inventory";
import { isSimNamespace } from "@/lib/kiosk/simulator";

describe("scanApiRoutes", () => {
  it("extracts methods, paths, domains and heuristic auth from route files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apimap-"));
    const api = path.join(dir, "src", "app", "api");
    fs.mkdirSync(path.join(api, "system", "things", "[id]"), { recursive: true });
    fs.mkdirSync(path.join(api, "webhooks", "stripe"), { recursive: true });
    fs.writeFileSync(path.join(api, "system", "things", "route.ts"),
      `import { systemApiGuard } from "../_shared";\nexport async function GET() {}\nexport async function POST() {}\n`);
    fs.writeFileSync(path.join(api, "system", "things", "[id]", "route.ts"),
      `export async function DELETE() {}\n`);
    fs.writeFileSync(path.join(api, "webhooks", "stripe", "route.ts"),
      `export async function POST() {} // uses constructEvent\n`);
    // a non-route file must be ignored
    fs.writeFileSync(path.join(api, "webhooks", "notes.txt"), "nope");

    const inv = scanApiRoutes(api);
    expect(inv.available).toBe(true);
    const paths = inv.routes.map((r) => r.path);
    expect(paths).toContain("/api/system/things");
    expect(paths).toContain("/api/system/things/[id]");
    expect(paths).toContain("/api/webhooks/stripe");
    const things = inv.routes.find((r) => r.path === "/api/system/things")!;
    expect(things.methods.sort()).toEqual(["GET", "POST"]);
    expect(things.domain).toBe("system");
    expect(things.auth).toBe("system role + permission");
    const stripe = inv.routes.find((r) => r.path === "/api/webhooks/stripe")!;
    expect(stripe.auth).toBe("Stripe signature");
  });

  it("reports unavailable honestly when the api dir is missing", () => {
    const inv = scanApiRoutes(path.join(os.tmpdir(), "does-not-exist-" + Date.now()));
    expect(inv.available).toBe(false);
    expect(inv.routes).toEqual([]);
  });
});

describe("guessAuth", () => {
  it("classifies common gate markers", () => {
    expect(guessAuth("systemApiGuard(\"x\")")).toBe("system role + permission");
    expect(guessAuth("Bearer KIOSK_INGEST_SECRET")).toBe("Bearer KIOSK_INGEST_SECRET");
    expect(guessAuth("process.env.CRON_SECRET")).toBe("Bearer CRON_SECRET");
    expect(guessAuth("getSessionUser()")).toBe("customer session");
    expect(guessAuth("nothing recognizable")).toBe("public / route-specific — check source");
  });
});

describe("simulator namespace guard", () => {
  it("only sim-/SIM- identifiers count as simulator namespace", () => {
    expect(isSimNamespace("sim-abc123")).toBe(true);
    expect(isSimNamespace("SIM-STATION-1")).toBe(true);
    expect(isSimNamespace("KSK-0001")).toBe(false);
    expect(isSimNamespace("device-1")).toBe(false);
    expect(isSimNamespace(null)).toBe(false);
    expect(isSimNamespace("")).toBe(false);
  });
});
