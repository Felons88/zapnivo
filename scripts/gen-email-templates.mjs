// Regenerates src/lib/email-templates.ts from email-templates/*.html
// Run: node scripts/gen-email-templates.mjs
import fs from "node:fs";
import path from "node:path";

const dir = "email-templates";
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".html"));

let out = `/**
 * Branded transactional email templates (V2 design system).
 * Embedded as strings so they ship inside the serverless bundle (no fs reads).
 * Regenerate: node scripts/gen-email-templates.mjs
 */

const T: Record<string, string> = {
`;
for (const f of files) {
  const name = f.replace(".html", "");
  const html = fs.readFileSync(path.join(dir, f), "utf8")
    .replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  out += `  ${name}: \`${html}\`,\n`;
}
out += `};

const esc = (v: string) => v
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function renderEmail(name: keyof typeof T, vars: Record<string, string>): string {
  let html = T[name];
  if (!html) throw new Error("unknown_email_template:" + name);
  for (const [k, v] of Object.entries(vars)) html = html.split("{{" + k + "}}").join(esc(v));
  return html.replace(/{{[a-z_]+}}/g, "");
}
`;
fs.writeFileSync("src/lib/email-templates.ts", out);
console.log(`wrote src/lib/email-templates.ts — ${files.length} templates, ${out.length} bytes`);
