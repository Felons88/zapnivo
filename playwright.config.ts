import { defineConfig, devices } from "@playwright/test";

/**
 * SAFETY: the app servers below are started with every Supabase / Stripe / mail
 * credential overridden to an empty string (process env beats .env.local), so the
 * backend is "unconfigured" and no test can ever write a real row.
 *
 *  - main server (port 3100): production build via `next start`, unconfigured backend.
 *  - devstore server (port 3101): `next dev` with HELPDESK_DEV_STORE=1 (JSON store in
 *    .data/, synthetic users). Only used by e2e/devstore.spec.ts.
 *
 * Set E2E_DEV=1 to run the main server under `next dev` instead of build+start
 * (useful when the tree does not build). Set E2E_REUSE=1 to reuse running servers.
 */
const MAIN_PORT = 3100;
const DEV_PORT = 3101;

const SAFE_ENV: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  STRIPE_SECRET_KEY: "",
  STRIPE_WEBHOOK_SECRET: "",
  BREVO_API_KEY: "",
  RESEND_API_KEY: "",
  OPENROUTER_API_KEY: "",
  KIOSK_INGEST_SECRET: "",
  CRON_SECRET: "",
  HELPDESK_DEV_STORE: "",
  NEXT_TELEMETRY_DISABLED: "1",
};

const mainCmd = process.env.E2E_DEV
  ? `npx next dev -p ${MAIN_PORT}`
  : `npx next build && npx next start -p ${MAIN_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: process.env.E2E_DEV ? 90_000 : 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${MAIN_PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "desktop",
      testIgnore: [/mobile\.spec\.ts/, /devstore\.spec\.ts/],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      testIgnore: /devstore\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
    {
      name: "devstore",
      testMatch: /devstore\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${DEV_PORT}` },
    },
  ],
  webServer: [
    {
      command: mainCmd,
      url: `http://localhost:${MAIN_PORT}/login`,
      timeout: 600_000,
      reuseExistingServer: !!process.env.E2E_REUSE,
      env: {
        ...SAFE_ENV,
        NEXT_DIST_DIR: ".next-e2e",
        NEXT_PUBLIC_SITE_URL: `http://localhost:${MAIN_PORT}`,
        PORT: String(MAIN_PORT),
      },
    },
    {
      command: `npx next dev -p ${DEV_PORT}`,
      url: `http://localhost:${DEV_PORT}/login`,
      timeout: 300_000,
      reuseExistingServer: !!process.env.E2E_REUSE,
      env: {
        ...SAFE_ENV,
        HELPDESK_DEV_STORE: "1",
        NEXT_DIST_DIR: ".next-e2e-dev",
        NEXT_PUBLIC_SITE_URL: `http://localhost:${DEV_PORT}`,
        PORT: String(DEV_PORT),
      },
    },
  ],
});
