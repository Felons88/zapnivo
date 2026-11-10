// Regenerates src/lib/email-templates.ts from email-templates/*.html
// Run: node scripts/gen-email-templates.mjs
//
// Sources:
//   email-templates/<name>.html   — HTML template (may use {{>part}} includes)
//   email-templates/parts/*.html  — shared chrome fragments (resolved at gen time)
//   email-templates/text/<name>.txt — plain-text fallback for renderEmailText
//
// Includes use {{>name}} and are resolved BEFORE templates are embedded, so the
// generated module contains complete standalone HTML documents. {{var}} slots are
// still interpolated (escaped) at render time by renderEmail / renderEmailText.
import fs from "node:fs";
import path from "node:path";

const dir = "email-templates";
const partsDir = path.join(dir, "parts");
const textDir = path.join(dir, "text");

const escTs = (s) => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

// ── shared parts ──────────────────────────────────────────────────────────────
const parts = {};
if (fs.existsSync(partsDir)) {
  for (const f of fs.readdirSync(partsDir).filter((f) => f.endsWith(".html"))) {
    parts[f.replace(/\.html$/, "")] = fs.readFileSync(path.join(partsDir, f), "utf8").trim();
  }
}

const INCLUDE_RE = /\{\{>\s*([a-zA-Z0-9_]+)\s*\}\}/g;
function resolveIncludes(src, stack = []) {
  return src.replace(INCLUDE_RE, (m, name) => {
    if (stack.includes(name)) throw new Error(`circular email include: ${[...stack, name].join(" -> ")}`);
    const part = parts[name];
    if (part === undefined) throw new Error(`unknown email include: {{>${name}}}`);
    return resolveIncludes(part, [...stack, name]);
  });
}

// ── collect templates ─────────────────────────────────────────────────────────
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".html"));
if (files.length === 0) throw new Error("no email templates found in " + dir);

const htmlEntries = [];
const textEntries = [];
for (const f of files) {
  const name = f.replace(/\.html$/, "");
  const raw = fs.readFileSync(path.join(dir, f), "utf8");
  const html = resolveIncludes(raw);
  if (html.includes("{{>")) throw new Error(`${f}: unresolved include`);
  htmlEntries.push([name, html]);

  const textPath = path.join(textDir, `${name}.txt`);
  if (!fs.existsSync(textPath)) throw new Error(`missing text fallback: ${textPath}`);
  textEntries.push([name, fs.readFileSync(textPath, "utf8").trim()]);
}
htmlEntries.sort((a, b) => a[0].localeCompare(b[0]));
textEntries.sort((a, b) => a[0].localeCompare(b[0]));

const mapTs = (entries) =>
  entries.map(([k, v]) => `  ${k}: \`${escTs(v)}\`,`).join("\n");

let out = `/**
 * Branded transactional email templates (V2 design system).
 * Embedded as strings so they ship inside the serverless bundle (no fs reads).
 * Regenerate: node scripts/gen-email-templates.mjs
 * Sources live in email-templates/ (HTML + text/ fallbacks + parts/ includes).
 */

const T: Record<string, string> = {
${mapTs(htmlEntries)}
};

const T_TEXT: Record<string, string> = {
${mapTs(textEntries)}
};

/** Names of every registered email template. */
export const EMAIL_TEMPLATE_NAMES: string[] = Object.keys(T);

const esc = (v: string) => v
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function renderEmail(name: keyof typeof T, vars: Record<string, string>): string {
  let html = T[name];
  if (!html) throw new Error("unknown_email_template:" + name);
  for (const [k, v] of Object.entries(vars)) html = html.split("{{" + k + "}}").join(esc(v));
  return html.replace(/{{[a-z_]+}}/g, "");
}

/** Plain-text counterpart of renderEmail — raw interpolation, no HTML escaping. */
export function renderEmailText(name: keyof typeof T, vars: Record<string, string>): string {
  let text = T_TEXT[name];
  if (!text) throw new Error("unknown_email_template:" + name);
  for (const [k, v] of Object.entries(vars)) text = text.split("{{" + k + "}}").join(v);
  return text.replace(/{{[a-z_]+}}/g, "");
}
`;
fs.writeFileSync("src/lib/email-templates.ts", out);
console.log(`wrote src/lib/email-templates.ts — ${files.length} templates (${textEntries.length} text fallbacks), ${out.length} bytes`);
