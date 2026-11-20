import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SYSTEM_PERMISSIONS } from "../src/lib/system/rbac";
import permissions from "../src/lib/system/route-permissions.json";

describe("system navigation permission inventory", () => {
  it("maps every system navigation target to a real gated page", () => {
    const source = readFileSync(join(process.cwd(), "src/components/SystemShell.tsx"), "utf8");
    const paths = [...source.matchAll(/href: "(\/system[^"]+)"/g)].map((match) => match[1]);
    const known = permissions as Record<string, string>;
    for (const path of paths) {
      expect(known, path).toHaveProperty(path);
      if (path === "/system" || path === "/system/security/bootstrap") continue;
      expect(SYSTEM_PERMISSIONS, path).toContain(known[path]);
    }
  });
});
