import { beforeEach, describe, expect, it, vi } from "vitest";

/* ── Fakes ─────────────────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;

const { dbHolder, integHolder, readyHolder, kioskHolder, mailerHolder } = vi.hoisted(() => ({
  dbHolder: { db: null as unknown },
  integHolder: { rows: [] as Record<string, unknown>[] },
  readyHolder: { readiness: null as unknown },
  kioskHolder: { adapter: "none" },
  mailerHolder: { configured: false },
}));

/**
 * Minimal Supabase stub covering the acceptance engine's query surface:
 * select(cols,{count,head}) + eq/in/not-is/gte + order/limit, awaited to
 * { data, count, error }. Missing tables error honestly (never fake zeros).
 */
function createFakeDb(tables: Record<string, Row[]> = {}) {
  const store: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(tables)) store[t] = rows.map((r) => ({ ...r }));
  const cmp = (a: unknown, b: unknown) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;

  const from = (table: string) => {
    const exists = table in store;
    const st = {
      filters: [] as ((r: Row) => boolean)[],
      orderBy: null as { col: string; asc: boolean } | null,
      lim: Number.POSITIVE_INFINITY,
      head: false,
    };
    const match = (r: Row) => st.filters.every((f) => f(r));
    const exec = () => {
      if (!exists) return { data: null, error: { message: `relation ${table} does not exist` }, count: null };
      let out = store[table].filter(match);
      if (st.orderBy) {
        const { col, asc } = st.orderBy;
        out = [...out].sort((a, b) => (asc ? cmp(a[col], b[col]) : -cmp(a[col], b[col])));
      }
      if (st.lim !== Number.POSITIVE_INFINITY) out = out.slice(0, st.lim);
      if (st.head) return { data: null, error: null, count: out.length };
      return { data: out, error: null, count: out.length };
    };
    const b: Record<string, unknown> = {
      select: (_c?: unknown, opts?: { head?: boolean }) => { if (opts?.head) st.head = true; return b; },
      eq: (c: string, v: unknown) => { st.filters.push((r) => (r[c] ?? null) === (v ?? null)); return b; },
      in: (c: string, vs: unknown[]) => { st.filters.push((r) => vs.includes(r[c])); return b; },
      not: (c: string, op: string, v: unknown) => {
        if (op === "is") st.filters.push((r) => (r[c] ?? null) !== v);
        return b;
      },
      gte: (c: string, v: unknown) => { st.filters.push((r) => cmp(r[c], v) >= 0); return b; },
      order: (c: string, o?: { ascending?: boolean }) => { st.orderBy = { col: c, asc: o?.ascending !== false }; return b; },
      limit: (n: number) => { st.lim = n; return b; },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve().then(exec).then(res, rej),
    };
    return b;
  };
  return { from, _tables: store };
}

vi.mock("@/lib/supabase", () => ({
  serviceClient: () => dbHolder.db,
  backendConfigured: () => dbHolder.db !== null,
}));
vi.mock("@/lib/system/integrations", () => ({
  listIntegrationStatus: async () => integHolder.rows,
}));
vi.mock("@/lib/system/readiness", () => ({
  securityReadiness: async () => readyHolder.readiness,
}));
vi.mock("@/lib/system/kiosks", () => ({
  kioskAdapterName: () => kioskHolder.adapter,
}));
vi.mock("@/lib/helpdesk/mailer", () => ({
  mailerConfigured: () => mailerHolder.configured,
}));
vi.mock("@/app/api/system/_shared", () => ({
  systemApiGuard: async () => ({ ok: true, user: { id: "u1" }, role: "sysadmin", db: dbHolder.db }),
}));
vi.mock("@/lib/system/launch", () => ({
  launchReadiness: async () => ({
    generatedAt: "2026-02-01T00:00:00Z", subsystems: [], blockers: [], counts: {},
  }),
}));

import { getAcceptanceChecks, ACCEPTANCE_CATEGORIES } from "@/lib/system/acceptance";

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

const providerRow = (id: string, configured: boolean, hc: unknown = null) => ({
  id, name: id, category: "scm", purpose: "", envVars: ["X_KEY"],
  envPresence: [], configured, mode: "test", webhook: null, status: "unknown",
  lastHealthCheck: hc,
});

const hcOk = { status: "operational", checkedAt: "2026-02-01T00:00:00Z", latencyMs: 9, detail: "ok" };
const hcBad = { status: "degraded", checkedAt: "2026-02-01T00:00:00Z", latencyMs: 9, detail: "boom" };

const checklistItem = (id: string, status: "verified_by_code" | "pending_manual" | "blocked") => ({
  id, label: id, status, evidence: `evidence for ${id}`, action: `action for ${id}`,
});

const baseReadiness = {
  configured: true,
  generated_at: "2026-02-01T00:00:00Z",
  bootstrap_grants: 0,
  recovery_tests: 0,
  recovery_last_test: null,
  backup: { state: "no_verified_backup", provider_snapshot: null },
  admin_checklist: [
    checklistItem("bootstrap_token", "verified_by_code"),
    checklistItem("supabase_redirect_url", "pending_manual"),
    checklistItem("first_admin_role", "pending_manual"),
    checklistItem("totp_enrolled", "pending_manual"),
    checklistItem("mfa_verify_tested", "pending_manual"),
    checklistItem("step_up_elevation", "pending_manual"),
    checklistItem("session_expiration", "verified_by_code"),
    checklistItem("session_revocation_tested", "pending_manual"),
    checklistItem("access_control_tests", "pending_manual"),
  ],
};

const emptyDb = () => createFakeDb({});

/** DB with NO evidence rows anywhere — every table exists but is empty. */
const emptyEvidenceDb = () => createFakeDb({
  site_content_revisions: [],
  site_content: [],
  system_deployment_requests: [],
  system_audit_events: [],
  email_outbox: [],
  email_delivery_events: [],
  newsletter_subscribers: [],
  profiles: [],
  system_devices: [],
  system_certification_runs: [],
});

/** DB with full positive evidence for every check. */
const fullEvidenceDb = () => createFakeDb({
  site_content_revisions: [
    { id: "r1", action: "save_draft" }, { id: "r2", action: "publish" }, { id: "r3", action: "revert" },
  ],
  site_content: [{ id: "c1", status: "published" }, { id: "c2", status: "draft" }],
  system_deployment_requests: [
    { id: "d1", action: "deploy", target_env: "preview", status: "executed", created_at: "2026-02-01T00:00:00Z", result: { provider: "vercel" } },
    { id: "d2", action: "deploy", target_env: "production", status: "executed", created_at: "2026-02-02T00:00:00Z",
      result: { health: { status: "healthy" }, healthProfile: { status: "healthy" } } },
  ],
  system_audit_events: [
    { id: "a1", action: "deployment.health_checked", detail: { health_status: "healthy" }, created_at: "2026-02-02T01:00:00Z" },
  ],
  email_outbox: [
    { id: "e1", status: "sent", event: "ticket.reply" },
    { id: "e2", status: "sent", event: "newsletter.confirm" },
  ],
  email_delivery_events: [{ id: "v1", provider: "brevo" }],
  newsletter_subscribers: [{ id: "s1", status: "confirmed" }, { id: "s2", status: "unsubscribed" }],
  profiles: [{ id: "p1", system_role: "sysadmin" }],
  system_devices: [{ id: "dev1", last_heartbeat_at: new Date().toISOString() }],
  system_certification_runs: [{ id: "cr1", tier: "physical", status: "pass" }],
});

const readinessFull = {
  ...baseReadiness,
  bootstrap_grants: 1,
  recovery_tests: 2,
  recovery_last_test: { result: "passed", tested_at: "2026-02-01T00:00:00Z", environment: "staging" },
  backup: { state: "restore_tested", provider_snapshot: { as_of: "2026-02-01", pitr_enabled: true } },
  admin_checklist: baseReadiness.admin_checklist.map((i) =>
    ["first_admin_role", "mfa_verify_tested", "step_up_elevation"].includes(i.id)
      ? checklistItem(i.id, "verified_by_code")
      : i),
};

beforeEach(() => {
  dbHolder.db = emptyEvidenceDb();
  integHolder.rows = ["github", "vercel", "brevo", "resend"].map((id) => providerRow(id, true, hcOk));
  readyHolder.readiness = baseReadiness;
  kioskHolder.adapter = "none";
  mailerHolder.configured = false;
});

const check = async (id: string) => {
  const r = await getAcceptanceChecks(dbHolder.db as never);
  const c = r.categories.flatMap((cat) => cat.checks).find((x) => x.id === id);
  expect(c, `check ${id} exists`).toBeTruthy();
  return c!;
};

/* ── Shape / categories ────────────────────────────────────────────────────── */

describe("report shape", () => {
  it("returns all six categories with their checks", async () => {
    const r = await getAcceptanceChecks(dbHolder.db as never);
    expect(r.categories.map((c) => c.id)).toEqual(ACCEPTANCE_CATEGORIES.map((c) => c.id));
    const ids = r.categories.flatMap((c) => c.checks.map((k) => k.id));
    expect(ids).toEqual(expect.arrayContaining([
      "cms_draft_saved", "cms_published", "cms_revert_verified", "cms_preview",
      "github_connected", "vercel_connected", "preview_deployment_verified",
      "production_release_authorized", "release_health_verified",
      "email_sender_verified", "doi_confirmation_accepted", "delivery_webhook_verified", "unsubscribe_verified",
      "first_admin_enrolled", "mfa_verified", "step_up_verified", "session_expiration", "access_restrictions",
      "backup_exists", "restore_test_completed", "restore_validation_passed",
      "gateway_configured", "device_provisioned", "heartbeat_authenticated", "physical_certification_passed",
    ]));
    expect(r.counts.verified + r.counts.pending + r.counts.blocked + r.counts.failed).toBe(ids.length);
  });

  it("every check has valid href, evidence text, and ISO lastChecked", async () => {
    const r = await getAcceptanceChecks(dbHolder.db as never);
    for (const cat of r.categories) {
      for (const c of cat.checks) {
        expect(c.href).toMatch(/^\/system\//);
        expect(c.evidence.length).toBeGreaterThan(0);
        expect(c.lastChecked).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        if (c.state === "verified") expect(c.blocker ?? null).toBeNull();
      }
    }
  });
});

/* ── Honesty: empty evidence never verifies ────────────────────────────────── */

describe("empty evidence → pending/blocked, never verified", () => {
  it("no DB rows anywhere → zero verified checks", async () => {
    dbHolder.db = emptyEvidenceDb();
    integHolder.rows = ["github", "vercel", "brevo", "resend"].map((id) => providerRow(id, true, null));
    mailerHolder.configured = true;
    readyHolder.readiness = baseReadiness;
    const r = await getAcceptanceChecks(dbHolder.db as never);
    expect(r.counts.verified).toBe(0);
  });

  it("missing tables → blocked/pending with migration hints, not verified", async () => {
    dbHolder.db = emptyDb(); // every table missing
    integHolder.rows = ["github", "vercel", "brevo", "resend"].map((id) => providerRow(id, true, null));
    const r = await getAcceptanceChecks(dbHolder.db as never);
    expect(r.counts.verified).toBe(0);
    expect((await check("cms_draft_saved")).state).toBe("blocked");
    expect((await check("delivery_webhook_verified")).state).toBe("blocked");
    expect((await check("device_provisioned")).state).toBe("blocked");
    expect((await check("physical_certification_passed")).state).toBe("blocked");
  });

  it("null db → all DB-dependent checks pending, env/manual checks still evaluate", async () => {
    dbHolder.db = null;
    integHolder.rows = ["github", "vercel", "brevo", "resend"].map((id) => providerRow(id, true, null));
    const r = await getAcceptanceChecks(null);
    expect(r.counts.verified).toBe(0);
    expect((await check("cms_preview")).state).toBe("pending");
    expect((await check("cms_preview")).manual).toBe(true);
    expect((await check("gateway_configured")).state).toBe("blocked"); // KIOSK_ADAPTER=none
  });
});

/* ── Website ops ───────────────────────────────────────────────────────────── */

describe("website ops", () => {
  it("draft/publish/revert verified only with revision + published rows", async () => {
    expect((await check("cms_draft_saved")).state).toBe("pending"); // empty tables
    dbHolder.db = fullEvidenceDb();
    expect((await check("cms_draft_saved")).state).toBe("verified");
    expect((await check("cms_published")).state).toBe("verified");
    expect((await check("cms_revert_verified")).state).toBe("verified");
  });

  it("revert requires action='revert' specifically", async () => {
    dbHolder.db = createFakeDb({
      site_content_revisions: [{ id: "r1", action: "save_draft" }],
      site_content: [],
    });
    expect((await check("cms_draft_saved")).state).toBe("verified");
    expect((await check("cms_revert_verified")).state).toBe("pending");
    expect((await check("cms_published")).state).toBe("pending");
  });

  it("preview is always pending+manual — never faked", async () => {
    dbHolder.db = fullEvidenceDb();
    const c = await check("cms_preview");
    expect(c.state).toBe("pending");
    expect(c.manual).toBe(true);
  });
});

/* ── Deployment ops ────────────────────────────────────────────────────────── */

describe("deployment ops", () => {
  it("github/vercel verified only on recorded operational health check", async () => {
    integHolder.rows = [providerRow("github", true, hcOk), providerRow("vercel", true, null), providerRow("brevo", true, hcOk), providerRow("resend", true, hcOk)];
    expect((await check("github_connected")).state).toBe("verified");
    expect((await check("vercel_connected")).state).toBe("pending"); // configured, never checked
    integHolder.rows = [providerRow("github", true, hcBad), providerRow("vercel", true, hcOk), providerRow("brevo", true, hcOk), providerRow("resend", true, hcOk)];
    expect((await check("github_connected")).state).toBe("failed");
    integHolder.rows = [providerRow("github", false), providerRow("vercel", true, hcOk), providerRow("brevo", true, hcOk), providerRow("resend", true, hcOk)];
    expect((await check("github_connected")).state).toBe("pending");
    expect((await check("github_connected")).blocker).toContain("credentials/config");
  });

  it("preview + production verified only with executed request rows", async () => {
    dbHolder.db = fullEvidenceDb();
    expect((await check("preview_deployment_verified")).state).toBe("verified");
    expect((await check("production_release_authorized")).state).toBe("verified");
    expect((await check("release_health_verified")).state).toBe("verified");
  });

  it("approved-but-not-executed production request stays pending", async () => {
    dbHolder.db = createFakeDb({
      system_deployment_requests: [
        { id: "d1", target_env: "production", status: "approved", created_at: "2026-02-01T00:00:00Z", result: null },
      ],
      system_audit_events: [],
    });
    expect((await check("production_release_authorized")).state).toBe("pending");
    expect((await check("production_release_authorized")).evidence).toContain("approved but not yet executed");
    expect((await check("release_health_verified")).state).toBe("pending");
  });
});

/* ── Communications ────────────────────────────────────────────────────────── */

describe("communications", () => {
  it("sender verified by sent outbox rows OR recorded mailer health check", async () => {
    dbHolder.db = createFakeDb({ email_outbox: [{ id: "e1", status: "sent", event: "ticket.reply" }] });
    mailerHolder.configured = true;
    expect((await check("email_sender_verified")).state).toBe("verified");

    dbHolder.db = createFakeDb({ email_outbox: [] });
    mailerHolder.configured = true;
    expect((await check("email_sender_verified")).state).toBe("pending"); // env only — no send on record

    dbHolder.db = createFakeDb({ email_outbox: [] });
    integHolder.rows = [providerRow("github", true, hcOk), providerRow("vercel", true, hcOk), providerRow("brevo", true, null), providerRow("resend", true, null)];
    mailerHolder.configured = false;
    const c = await check("email_sender_verified");
    expect(c.state).toBe("pending");
    expect(c.blocker).toContain("credentials/config");
  });

  it("DOI confirmation needs sent newsletter events specifically", async () => {
    dbHolder.db = createFakeDb({
      email_outbox: [{ id: "e1", status: "sent", event: "ticket.reply" }],
    });
    expect((await check("doi_confirmation_accepted")).state).toBe("pending");
    dbHolder.db = createFakeDb({
      email_outbox: [{ id: "e1", status: "sent", event: "newsletter.welcome" }],
    });
    expect((await check("doi_confirmation_accepted")).state).toBe("verified");
    // queued ≠ sent
    dbHolder.db = createFakeDb({
      email_outbox: [{ id: "e1", status: "queued", event: "newsletter.confirm" }],
    });
    expect((await check("doi_confirmation_accepted")).state).toBe("pending");
  });

  it("delivery webhook + unsubscribe need real rows", async () => {
    dbHolder.db = fullEvidenceDb();
    expect((await check("delivery_webhook_verified")).state).toBe("verified");
    expect((await check("unsubscribe_verified")).state).toBe("verified");
    dbHolder.db = createFakeDb({
      email_delivery_events: [],
      newsletter_subscribers: [{ id: "s1", status: "confirmed" }],
    });
    expect((await check("delivery_webhook_verified")).state).toBe("pending");
    expect((await check("unsubscribe_verified")).state).toBe("pending");
  });
});

/* ── Security ──────────────────────────────────────────────────────────────── */

describe("security", () => {
  it("maps admin checklist honestly: verified_by_code→verified, pending_manual→pending+manual, blocked→blocked", async () => {
    dbHolder.db = fullEvidenceDb();
    readyHolder.readiness = readinessFull;
    expect((await check("first_admin_enrolled")).state).toBe("verified");
    expect((await check("mfa_verified")).state).toBe("verified");
    expect((await check("step_up_verified")).state).toBe("verified");

    readyHolder.readiness = baseReadiness; // all manual items pending
    expect((await check("mfa_verified")).state).toBe("pending");
    expect((await check("mfa_verified")).manual).toBe(true);
    expect((await check("first_admin_enrolled")).state).toBe("pending");
  });

  it("session expiration is NEVER verified from code alone", async () => {
    readyHolder.readiness = readinessFull; // even with everything else verified
    const c = await check("session_expiration");
    expect(c.state).toBe("pending");
    expect(c.manual).toBe(true);
  });

  it("access restrictions verified only when role grants exist", async () => {
    dbHolder.db = fullEvidenceDb();
    readyHolder.readiness = readinessFull;
    expect((await check("access_restrictions")).state).toBe("verified");
    dbHolder.db = createFakeDb({ profiles: [] });
    readyHolder.readiness = { ...readinessFull, bootstrap_grants: 0 };
    expect((await check("access_restrictions")).state).toBe("pending");
  });
});

/* ── Recovery ──────────────────────────────────────────────────────────────── */

describe("recovery", () => {
  it("backup states map honestly", async () => {
    dbHolder.db = fullEvidenceDb();
    readyHolder.readiness = { ...baseReadiness, backup: { state: "no_verified_backup", provider_snapshot: null } };
    expect((await check("backup_exists")).state).toBe("blocked");
    readyHolder.readiness = { ...baseReadiness, backup: { state: "backup_configured", provider_snapshot: { pitr_enabled: true } } };
    expect((await check("backup_exists")).state).toBe("pending"); // config-level only
    readyHolder.readiness = { ...baseReadiness, backup: { state: "backup_available", provider_snapshot: null } };
    expect((await check("backup_exists")).state).toBe("verified");
    readyHolder.readiness = readinessFull;
    expect((await check("backup_exists")).state).toBe("verified");
    expect((await check("restore_test_completed")).state).toBe("verified");
    expect((await check("restore_validation_passed")).state).toBe("verified");
  });

  it("failed restore → 'failed' state, not pending", async () => {
    dbHolder.db = fullEvidenceDb();
    readyHolder.readiness = {
      ...baseReadiness,
      recovery_tests: 1,
      recovery_last_test: { result: "failed", tested_at: "2026-02-01T00:00:00Z", environment: "staging" },
    };
    expect((await check("restore_test_completed")).state).toBe("verified");
    expect((await check("restore_validation_passed")).state).toBe("failed");
    readyHolder.readiness = baseReadiness; // no tests at all
    expect((await check("restore_validation_passed")).state).toBe("pending");
  });
});

/* ── Hardware ──────────────────────────────────────────────────────────────── */

describe("hardware", () => {
  it("KIOSK_ADAPTER=none → blocked; simulator → pending", async () => {
    kioskHolder.adapter = "none";
    expect((await check("gateway_configured")).state).toBe("blocked");
    kioskHolder.adapter = "simulator";
    expect((await check("gateway_configured")).state).toBe("pending");
  });

  it("device + heartbeat + physical cert verified only with real rows", async () => {
    dbHolder.db = emptyEvidenceDb();
    expect((await check("device_provisioned")).state).toBe("pending");
    expect((await check("heartbeat_authenticated")).state).toBe("pending");
    expect((await check("physical_certification_passed")).state).toBe("pending");

    dbHolder.db = fullEvidenceDb();
    expect((await check("device_provisioned")).state).toBe("verified");
    expect((await check("heartbeat_authenticated")).state).toBe("verified");
    expect((await check("physical_certification_passed")).state).toBe("verified");
  });

  it("stale heartbeat does not verify; physical runs without pass → failed", async () => {
    dbHolder.db = createFakeDb({
      system_devices: [{ id: "dev1", last_heartbeat_at: "2020-01-01T00:00:00Z" }],
      system_certification_runs: [{ id: "cr1", tier: "physical", status: "fail" }],
    });
    expect((await check("heartbeat_authenticated")).state).toBe("pending");
    expect((await check("physical_certification_passed")).state).toBe("failed");
    // simulated-tier passes never count as physical
    dbHolder.db = createFakeDb({
      system_certification_runs: [{ id: "cr1", tier: "simulated", status: "pass" }],
    });
    expect((await check("physical_certification_passed")).state).toBe("pending");
  });
});

/* ── Launch API shape ──────────────────────────────────────────────────────── */

describe("GET /api/system/launch", () => {
  it("response keeps LaunchReadiness keys and adds acceptance report", async () => {
    const { GET } = await import("@/app/api/system/launch/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subsystems).toBeDefined();
    expect(body.blockers).toBeDefined();
    expect(body.counts).toBeDefined();
    expect(body.acceptance).toBeDefined();
    expect(body.acceptance.categories.length).toBe(6);
    expect(body.acceptance.counts).toBeDefined();
  });
});
