import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { EMAIL_TEMPLATE_NAMES, renderEmail, renderEmailText } from "@/lib/email-templates";

const ROOT = path.resolve(__dirname, "..");
const TPL_DIR = path.join(ROOT, "email-templates");

const htmlFiles = () =>
  fs.readdirSync(TPL_DIR).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, ""));

/** Every {{var}} slot a template can contain, including vars inside shared parts. */
function varsFor(name: string): string[] {
  const sources = [
    fs.readFileSync(path.join(TPL_DIR, `${name}.html`), "utf8"),
    ...fs.readdirSync(path.join(TPL_DIR, "parts")).map((f) =>
      fs.readFileSync(path.join(TPL_DIR, "parts", f), "utf8")),
  ];
  const vars = new Set<string>();
  for (const src of sources)
    for (const m of src.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) vars.add(m[1]);
  vars.delete(">"); // include syntax is resolved at generation time, never rendered
  return [...vars];
}

const sampleVars = (name: string) =>
  Object.fromEntries(varsFor(name).map((v) => [v, `Sample ${v}`]));

describe("email template registry", () => {
  it("EMAIL_TEMPLATE_NAMES covers every .html file in email-templates/", () => {
    expect([...EMAIL_TEMPLATE_NAMES].sort()).toEqual(htmlFiles().sort());
  });

  it("every template has a text fallback", () => {
    for (const name of htmlFiles()) {
      expect(fs.existsSync(path.join(TPL_DIR, "text", `${name}.txt`)), name).toBe(true);
    }
  });
});

describe("renderEmail", () => {
  it("renders every template as a complete HTML document with no leftover slots", () => {
    for (const name of EMAIL_TEMPLATE_NAMES) {
      const html = renderEmail(name, sampleVars(name));
      expect(html.startsWith("<!doctype html>"), name).toBe(true);
      expect(html, name).not.toMatch(/\{\{[a-z_]+\}\}/);
      expect(html, name).toContain("ZAP");
      expect(html, name).toContain("NIVO");
    }
  });

  it("escapes interpolated variables (XSS probe)", () => {
    const xss = `<img src=x onerror="alert('pwned')">`;
    const html = renderEmail("payment_receipt", {
      ...sampleVars("payment_receipt"),
      receipt_id: xss,
      rental_id: xss,
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("onerror=&quot;alert(&#39;pwned&#39;)&quot;");
  });

  it("throws on an unknown template name", () => {
    expect(() => renderEmail("no_such_template" as never, {})).toThrow(/unknown_email_template/);
    expect(() => renderEmailText("no_such_template" as never, {})).toThrow(/unknown_email_template/);
  });
});

describe("renderEmailText", () => {
  it("interpolates every template's text fallback with no leftover slots", () => {
    for (const name of EMAIL_TEMPLATE_NAMES) {
      const text = renderEmailText(name, sampleVars(name));
      expect(text.trim().length, name).toBeGreaterThan(20);
      expect(text, name).not.toMatch(/\{\{[a-z_]+\}\}/);
    }
  });

  it("inserts values raw (plain text, no HTML escaping)", () => {
    const text = renderEmailText("payment_receipt", {
      ...sampleVars("payment_receipt"),
      total_paid: "$6.99 <test>",
    });
    expect(text).toContain("$6.99 <test>");
    expect(text).not.toContain("&lt;");
  });
});

describe("pricing language audit", () => {
  it("no stale 'daily cap' / first24hCap pricing language in templates or triggers", () => {
    const files = [
      ...fs.readdirSync(TPL_DIR).filter((f) => f.endsWith(".html") || f.endsWith(".txt"))
        .map((f) => path.join(TPL_DIR, f)),
      ...fs.readdirSync(path.join(TPL_DIR, "parts")).map((f) => path.join(TPL_DIR, "parts", f)),
      ...fs.readdirSync(path.join(TPL_DIR, "text")).map((f) => path.join(TPL_DIR, "text", f)),
      path.join(ROOT, "src/lib/email-triggers.ts"),
      path.join(ROOT, "src/lib/email-extra-triggers.ts"),
    ];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/day cap|daily cap|\/day\b|first24hCap/i);
    }
  });
});
