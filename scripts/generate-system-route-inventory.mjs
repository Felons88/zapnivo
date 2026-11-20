import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, dirname } from "node:path";

const root = process.cwd();
const pagesRoot = join(root, "src", "app", "system");
const adminRoot = join(root, "src", "app", "admin");
const out = join(root, "docs", "audits", "system-redesign-route-inventory.md");
const permissionOutput = join(root, "src", "lib", "system", "route-permissions.json");
const apiOutput = join(root, "docs", "audits", "internal-api-inventory.md");
const roles = {
  "system.dashboard.view": "viewer, developer, hardware, engineer, security, sysadmin, breakglass",
  "system.kiosks.view": "viewer, developer, hardware, engineer, security, sysadmin, breakglass",
  "system.kiosks.manage": "hardware, engineer, sysadmin, breakglass",
  "system.integrations.view": "viewer, developer, hardware, engineer, security, sysadmin, breakglass",
  "system.integrations.manage": "engineer, sysadmin, breakglass",
  "system.secrets.rotate": "security, sysadmin, breakglass",
  "system.deployments.view": "viewer, developer, engineer, security, sysadmin, breakglass",
  "system.deployments.manage": "developer, engineer, sysadmin, breakglass",
  "system.database.schema.view": "viewer, developer, engineer, security, sysadmin, breakglass",
  "system.webhooks.retry": "developer, engineer, sysadmin, breakglass",
  "system.ai.view": "viewer, developer, engineer, security, sysadmin, breakglass",
  "system.ai.manage": "developer, engineer, sysadmin, breakglass",
  "system.security.audit.view": "viewer, developer, engineer, security, sysadmin, breakglass",
  "system.users.manage": "security, sysadmin, breakglass",
  "system.changes.view": "viewer, developer, hardware, engineer, security, sysadmin, breakglass",
  "system.changes.request": "hardware, engineer, security, sysadmin, breakglass",
  "system.changes.decide": "security, sysadmin, breakglass",
  "system.flags.view": "viewer, developer, hardware, engineer, security, sysadmin, breakglass",
  "system.flags.manage": "developer, engineer, sysadmin, breakglass",
  "system.emergency.view": "viewer, developer, hardware, engineer, security, sysadmin, breakglass",
  "system.emergency.request": "developer, hardware, engineer, security, sysadmin, breakglass",
  "system.emergency.execute": "security, sysadmin, breakglass",
  "system.emergency.approve": "security, sysadmin",
};

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
  return files.flat();
}

const escapeCell = (s) => String(s).replaceAll("|", "\\|").replaceAll("\n", " ").trim();
const unique = (items) => [...new Set(items)];
const label = (route) => route === "/system" ? "System home" : route.split("/").slice(2).map((x) => x.startsWith("[") ? "detail" : x.replaceAll("-", " ")).join(" / ");
const workspace = (route) => {
  if (route.startsWith("/admin")) return "Business portal workspace";
  const section = route.split("/")[2] ?? "home";
  if (["kiosks", "venues"].includes(section)) return "Kiosk & venue workspace";
  if (["security", "secrets", "keys", "changes", "approvals", "emergency"].includes(section)) return "Security workspace";
  if (["deployments", "app", "sites"].includes(section)) return "Application & deployment workspace";
  if (["database", "infrastructure", "integrations", "webhooks", "jobs"].includes(section)) return "Infrastructure workspace";
  if (["observability", "status", "health", "incidents", "activity"].includes(section)) return "Observability workspace";
  if (["ai", "dev"].includes(section)) return "Developer & AI workspace";
  return "System workspace";
};

const all = await walk(pagesRoot);
const pages = all.filter((file) => file.endsWith("page.tsx")).sort();
const rows = [];
for (const file of pages) {
  const source = await readFile(file, "utf8");
  const route = "/system" + relative(pagesRoot, dirname(file)).replaceAll("\\", "/").replace(/^\.$/, "").replace(/^\//, "").replace(/^(.+)/, "/$1");
  const title = source.match(/metadata\s*:\s*Metadata\s*=\s*\{\s*title:\s*["'`]([^"'`]+)/)?.[1]
    ?? source.match(/<h1[^>]*>([^<{]+)/)?.[1]?.trim()
    ?? label(route);
  const perm = source.match(/<SystemGate\s+perm=["']([^"']+)/)?.[1]
    ?? (route === "/system/security/bootstrap" ? "Session + one-time bootstrap token and TOTP"
      : route === "/system" ? "Session + business staff or system role" : "MISSING PAGE GATE");
  const localImports = unique([...source.matchAll(/from\s+["']\.\/(.+?)["']/g)].map((m) => m[1]));
  const componentFiles = localImports.map((name) => join(dirname(file), name + ".tsx")).filter((path) => all.includes(path));
  const dependentSource = (await Promise.all(componentFiles.map((path) => readFile(path, "utf8")))).join("\n");
  const combined = source + "\n" + dependentSource;
  const services = unique([...combined.matchAll(/from\s+["']@\/lib\/(system\/[^"']+|[^"']+)["']/g)].map((m) => m[1])).slice(0, 8);
  const apis = unique([...combined.matchAll(/\/api\/[A-Za-z0-9_./\[\]-]+/g)].map((m) => m[0])).slice(0, 8);
  const mutation = /method=["']post|method:\s*["'](?:POST|PUT|PATCH|DELETE)|fetch\([^\n]+\{[^\n]*method|\.insert\(|\.update\(|\.delete\(/i.test(combined)
    ? "Yes; inspect server guard and audit" : "No direct UI mutation found";
  const realtime = /FleetLive|LiveSync|realtime|subscribe\(/.test(combined) ? "Route-specific live behavior" : "Shared LiveSync in layout";
  rows.push({ route, title, perm, localImports, services, apis, mutation, realtime });
}

const adminAll = await walk(adminRoot);
for (const file of adminAll.filter((entry) => entry.endsWith("page.tsx")).sort()) {
  const source = await readFile(file, "utf8");
  const route = "/admin" + relative(adminRoot, dirname(file)).replaceAll("\\", "/").replace(/^\.$/, "").replace(/^\//, "").replace(/^(.+)/, "/$1");
  const title = source.match(/metadata\s*:\s*Metadata\s*=\s*\{\s*title:\s*["'`]([^"'`]+)/)?.[1]
    ?? source.match(/<h1[^>]*>([^<{]+)/)?.[1]?.trim() ?? label(route);
  const perm = /<AdminGate\b/.test(source) ? "Business admin/staff" : "Review page gate";
  const localImports = unique([...source.matchAll(/from\s+["']\.\/(.+?)["']/g)].map((m) => m[1]));
  const componentFiles = localImports.map((name) => join(dirname(file), name + ".tsx")).filter((path) => adminAll.includes(path));
  const dependentSource = (await Promise.all(componentFiles.map((path) => readFile(path, "utf8")))).join("\n");
  const combined = source + "\n" + dependentSource;
  const services = unique([...combined.matchAll(/from\s+["']@\/lib\/([^"']+)["']/g)].map((m) => m[1])).slice(0, 8);
  const apis = unique([...combined.matchAll(/\/api\/[A-Za-z0-9_./\[\]-]+/g)].map((m) => m[0])).slice(0, 8);
  const mutation = /method=["']post|method:\s*["'](?:POST|PUT|PATCH|DELETE)|fetch\([^\n]+\{[^\n]*method|\.insert\(|\.update\(|\.delete\(/i.test(combined)
    ? "Yes; inspect server guard and audit" : "No direct UI mutation found";
  rows.push({ route, title, perm, localImports, services, apis, mutation, realtime: "Shared AdminGate LiveSync" });
}

const lines = [
  "# System platform route and dependency inventory",
  "",
  "Generated from the current checkout by `node scripts/generate-system-route-inventory.mjs`. This is a code inventory, not a claim that every workflow has passed visual QA. Update it after route changes.",
  "",
  `**${rows.length} internal page routes**: ${pages.length} under \`/system\` and ${rows.length - pages.length} under \`/admin\`. System routes inherit the session gate, shell, and realtime subscription from \`src/app/system/layout.tsx\`. Business routes use \`AdminGate\`. API mutations must continue to use their route-level guards and audit services.`,
  "",
  "## Architecture and shared dependencies",
  "",
  "- Next.js 16 App Router, React 19, TypeScript, Tailwind v4; `src/proxy.ts` maps `system.zapnivo.com` to `/system`.",
  "- `SystemShell` and `SystemNavigation` provide current chrome; `SystemGate` provides page permission checks; `src/lib/system/rbac.ts` defines roles and permission tiers.",
  "- `src/app/api/system` contains the API routes; `src/lib/system` holds domain services; Supabase and existing integrations remain the data source.",
  "- The current shared layout subscribes to live tables through `LiveSync` and refreshes the route; route-specific live components are listed below.",
  "- Auth and session handling remain in `src/lib/auth.ts`. Server routes must independently enforce RBAC even when navigation hides a destination.",
  "- The business portal uses the broader `admin`/`staff` role gate. It does not currently define separate finance privileges; creating those requires a backend role model and route/API audit before any finance restriction is claimed.",
  "",
  "## Route checklist",
  "",
  "The last two columns are the redesign plan and QA status. `Unverified` means no route-specific defect was asserted without visual evidence. The bootstrap page is intentionally exempt from SystemGate; its API enforces the one-time bootstrap path.",
  "",
  "| Route | Purpose | Required permission / eligible roles | Local components | Service and API dependencies | Mutations / live updates | Proposed layout and audit |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| \`${escapeCell(r.route)}\` | ${escapeCell(r.title)} | \`${escapeCell(r.perm)}\` · ${escapeCell(roles[r.perm] ?? (r.route === "/system/security/bootstrap" ? "Signed-in bootstrap candidate" : "Review permission mapping"))} | ${escapeCell(r.localImports.join(", ") || "Page only")} | ${escapeCell(r.services.join(", ") || "None imported")}; API: ${escapeCell(r.apis.join(", ") || "No literal client API")} | ${escapeCell(r.mutation)}; ${escapeCell(r.realtime)} | ${workspace(r.route)} pattern; visual and keyboard audit unverified |`),
  "",
  "## Migration progress",
  "",
  ...rows.map((r) => `- [ ] ${r.route} — shared shell, page content, permissions, responsive and keyboard QA`),
  "",
  "## Discovery risks and dependencies to preserve",
  "",
  "- Some page components call imported services directly, so a literal API path is not a complete dependency map. Review the listed service modules and the 129 `/api/system` handlers before editing any mutation.",
  "- The system and business portals have different role models. Cross-portal launch links require both visibility checks and the destination's existing server authorization.",
  "- Existing technical search intentionally excludes customer personal data. Keep business customer search in the authorized business portal.",
  "- The current overview exposes technical device/payment readiness data. Replacing it with an app launcher must retain the overview at a stable, permission-gated route.",
  "",
];
await writeFile(out, lines.join("\n").replace(/\n+$/, "") + "\n");
await writeFile(permissionOutput, JSON.stringify(Object.fromEntries(rows.filter(({ route }) => route.startsWith("/system")).map(({ route, perm }) => [route, perm])), null, 2) + "\n");
const apiRows = [];
for (const area of ["system", "admin"]) {
  const apiRoot = join(root, "src", "app", "api", area);
  for (const file of (await walk(apiRoot)).filter((entry) => entry.endsWith("route.ts")).sort()) {
    const source = await readFile(file, "utf8");
    const route = "/api/" + area + relative(apiRoot, dirname(file)).replaceAll("\\", "/").replace(/^\.$/, "").replace(/^\//, "").replace(/^(.+)/, "/$1");
    const methods = unique([...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)/g)].map((m) => m[1]));
    const guards = unique([...source.matchAll(/(?:systemApiGuard|requireSystem)\(\s*["']([^"']+)/g)].map((m) => m[1]));
    const auth = guards.length ? guards.join(", ") : /isStaff|isAdmin|authorize|guard|requireAuth|session/i.test(source) ? "Other auth check; inspect route" : "No literal auth check found";
    const audit = /systemAudit|auditLog|audit\(/.test(source) ? "Audit call present" : "Audit not found in route source";
    apiRows.push({ route, methods: methods.join(", ") || "Inspect export", auth, audit });
  }
}
await writeFile(apiOutput, [
  "# Internal API route inventory",
  "",
  `Generated from the current checkout: ${apiRows.length} route handlers (${apiRows.filter((r) => r.route.startsWith("/api/system")).length} system, ${apiRows.filter((r) => r.route.startsWith("/api/admin")).length} business). This is a source index, not a security certification. Indirect guards and audits in imported services require review before mutations change.`,
  "",
  "| Route | Methods | Permission or guard in route | Audit indicator |",
  "| --- | --- | --- | --- |",
  ...apiRows.map((row) => `| \`${escapeCell(row.route)}\` | ${escapeCell(row.methods)} | ${escapeCell(row.auth)} | ${escapeCell(row.audit)} |`),
  "",
].join("\n"));
console.log(`Wrote ${rows.length} route rows to ${relative(root, out)}`);
