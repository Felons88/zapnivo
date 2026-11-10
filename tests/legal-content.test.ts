import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const LEGAL_DIR = path.join(ROOT, "src/app/(site)/legal");
const APP_DIR = path.join(ROOT, "src/app");

function legalPages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return legalPages(p);
    return name === "page.tsx" ? [p] : [];
  });
}

const pages = legalPages(LEGAL_DIR);
const sources = pages.map((p) => ({ file: p, src: readFileSync(p, "utf8") }));

/** Maps an internal href like /legal/privacy to a real App Router route file, honoring (group) segments. */
function routeExists(href: string): boolean {
  const rel = href.replace(/^\/+/, "");
  const candidates = [
    path.join(APP_DIR, "(site)", rel, "page.tsx"),
    path.join(APP_DIR, rel, "page.tsx"),
    path.join(APP_DIR, "(site)", rel, "route.ts"),
    path.join(APP_DIR, rel, "route.ts"),
  ];
  return candidates.some((c) => existsSync(c));
}

describe("legal page content hygiene", () => {
  it("finds all six legal pages", () => {
    expect(pages.length).toBe(6);
  });

  it.each(sources.map((s) => [path.relative(ROOT, s.file), s.src] as const))(
    "%s has no review debris, lorem ipsum or TODO markers",
    (_file, src) => {
      expect(src).not.toMatch(/\[REVIEW/i);
      expect(src).not.toMatch(/lorem ipsum/i);
      expect(src).not.toMatch(/\bTODO\b/);
    },
  );

  it("has metadata title and description on every page", () => {
    for (const { src } of sources) {
      expect(src).toMatch(/export const metadata: Metadata = \{[^}]*title:/);
      expect(src).toMatch(/description:/);
    }
  });

  it("all internal links resolve to real routes", () => {
    const hrefs = new Set<string>();
    for (const { src } of sources) {
      for (const m of src.matchAll(/href="(\/[^"#?]*)"/g)) hrefs.add(m[1]);
    }
    expect(hrefs.size).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(routeExists(href), `dead link: ${href}`).toBe(true);
    }
  });

  it("states the confirmed pricing figures consistently", () => {
    const rental = sources.find((s) => s.file.includes("rental-terms"))!.src;
    expect(rental).toContain("$6.99");
    expect(rental).toContain("$45.00");
    expect(rental).toMatch(/24 hours|24-hour/);

    const refund = sources.find((s) => s.file.includes("refund-policy"))!.src;
    expect(refund).toContain("$45.00");
    expect(refund).toMatch(/24-hour/);

    // No stale or invented pricing figures anywhere in legal pages.
    for (const { file, src } of sources) {
      expect(src, `${file} mentions an unconfirmed daily rate`).not.toMatch(/\$\d+\s*(per day|daily)/i);
    }
  });
});
