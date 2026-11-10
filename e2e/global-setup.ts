import { ADMIN_PAGES, EXTRA_PATHS, PARTNER_PAGES, PUBLIC_PATHS } from "./helpers";

/**
 * `next dev` compiles routes lazily, which makes first hits slow and causes flaky timeouts
 * under parallel workers. Warm every route once, sequentially (dev mode only).
 */
export default async function globalSetup() {
  if (!process.env.E2E_DEV) return;
  const main = "http://localhost:3100";
  const dev = "http://localhost:3101";
  const hit = async (base: string, path: string, headers?: Record<string, string>) => {
    try {
      await fetch(base + path, { redirect: "manual", headers });
    } catch {
      /* warm-up only */
    }
  };
  const apex = [...PUBLIC_PATHS, ...EXTRA_PATHS, "/sitemap.xml", "/robots.txt", ...ADMIN_PAGES, ...PARTNER_PAGES];
  for (const p of apex) await hit(main, p);
  for (const p of ["/api/admin/fleet", "/api/admin/users", "/api/admin/payouts", "/api/admin/export?type=rentals", "/api/devices/events", "/api/contact", "/api/support/tickets", "/api/partner-applications", "/api/dev/as"]) {
    await hit(main, p);
  }
  for (const sub of ["support", "internal", "partners", "api"]) {
    for (const p of ["/", "/new", "/login", "/robots.txt", "/sitemap.xml"]) await hit(main, p, { host: `${sub}.localhost:3100` });
  }
  for (const p of [...ADMIN_PAGES, ...PARTNER_PAGES, "/login", "/api/dev/as?role=admin"]) await hit(dev, p);
}
