import fs from "node:fs";
import path from "node:path";

/**
 * Filesystem-derived API route inventory for /system/dev/api.
 *
 * Unlike the hand-curated API_CATALOG in devtools.ts, this scans every
 * route.ts under src/app/api at request time and reports the HTTP methods each
 * file actually exports plus a HEURISTIC auth label derived from source
 * markers. It is documentation, not enforcement — always verify against the
 * route source. When the filesystem is unavailable at runtime the page gets
 * an empty inventory and says so honestly.
 */

export type ApiRouteInfo = {
  /** Route path, e.g. /api/system/changes/[id]/decision */
  path: string;
  methods: string[];
  /** First path segment after /api/ — used for grouping. */
  domain: string;
  auth: string;
  file: string;
};

export type ApiInventory = {
  available: boolean;
  routes: ApiRouteInfo[];
};

const MAX_FILES = 400;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

const AUTH_RULES: readonly { re: RegExp; label: string }[] = [
  { re: /systemApiGuard|requireSystem/, label: "system role + permission" },
  { re: /KIOSK_INGEST_SECRET/, label: "Bearer KIOSK_INGEST_SECRET" },
  { re: /CRON_SECRET/, label: "Bearer CRON_SECRET" },
  { re: /EMAIL_INBOUND_SECRET/, label: "shared secret (EMAIL_INBOUND_SECRET)" },
  { re: /constructEvent|stripe\.webhooks|STRIPE_WEBHOOK_SECRET/, label: "Stripe signature" },
  { re: /twilio.*signature|validateRequest/i, label: "Twilio signature" },
  { re: /HELPDESK_SECRET|thread.*token|accessToken/i, label: "signed token / session" },
  { re: /getSessionUser|requireUser|devAuth/, label: "customer session" },
  { re: /NODE_ENV === "production"|devOnly|HELPDESK_DEV_STORE/, label: "dev-only (404 in production)" },
];

export function guessAuth(src: string): string {
  for (const r of AUTH_RULES) if (r.re.test(src)) return r.label;
  return "public / route-specific — check source";
}

function walk(dir: string, out: string[], depth = 0): void {
  if (depth > 8 || out.length >= MAX_FILES) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.isFile() && e.name === "route.ts") out.push(p);
  }
}

export function scanApiRoutes(apiDir?: string): ApiInventory {
  const dir = apiDir ?? path.join(process.cwd(), "src", "app", "api");
  const files: string[] = [];
  walk(dir, files);
  if (!files.length) return { available: false, routes: [] };

  const routes: ApiRouteInfo[] = [];
  for (const file of files) {
    // Path relative to the api dir: <...>/route.ts → /api/<...>
    const rel = path.relative(dir, file).replace(/\\/g, "/").replace(/\/route\.ts$/, "");
    const route = `/api${rel ? `/${rel}` : ""}`;
    let src = "";
    try { src = fs.readFileSync(file, "utf8"); } catch { continue; }
    const methods = METHODS.filter((m) =>
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(src) ||
      new RegExp(`export\\s+(?:const|let|var)\\s+${m}\\b`).test(src),
    );
    routes.push({
      path: route,
      methods: methods.length ? [...methods] : ["?"],
      domain: rel.split("/")[0] || "(root)",
      auth: guessAuth(src),
      file: path.relative(process.cwd(), file).replace(/\\/g, "/"),
    });
  }
  routes.sort((a, b) => a.path.localeCompare(b.path));
  return { available: true, routes };
}
