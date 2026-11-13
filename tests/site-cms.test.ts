import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SITE_REGISTRY, FIELD_CATALOG, catalogField, catalogFields, catalogPages, catalogPageExists,
  validateFieldValue, isSiteKey,
  saveDraft, publishDraft, schedulePublish, revertToRevision,
  type SiteContentRow, type ContentRevision, type FieldDef,
} from "@/lib/system/site-cms";
import { authorize, roleCan } from "@/lib/system/rbac";

/* ── Minimal Supabase stub (same shape as tests/system-retention.test.ts) ──── */

type Result = { data?: unknown; error?: { message: string } | null };

type TableState = {
  queue: Result[];          // terminal results consumed in call order (single/maybeSingle/then)
  inserted: unknown[];
  upserted: { payload: unknown; onConflict?: string }[];
  updates: { payload: unknown; filters: unknown[][] }[];
};

function fakeTable() {
  const state: TableState = { queue: [], inserted: [], upserted: [], updates: [] };
  const b: Record<string, unknown> = {};
  const next = (): Result => state.queue.length ? state.queue.shift()! : { data: null, error: null };

  for (const m of ["select", "eq", "neq", "in", "is", "not", "order", "lt", "lte", "gte", "gt", "filter", "limit", "delete"]) {
    b[m] = () => b;
  }
  b.insert = (row: unknown) => { state.inserted.push(row); return b; };
  b.upsert = (payload: unknown, opts?: { onConflict?: string }) => { state.upserted.push({ payload, onConflict: opts?.onConflict }); return b; };
  b.update = (payload: unknown) => {
    const filters: unknown[][] = [];
    const ub: Record<string, unknown> = {};
    for (const m of ["eq", "select"]) {
      ub[m] = (...a: unknown[]) => { if (m === "eq") filters.push([m, ...a]); return ub; };
    }
    ub.single = async () => next();
    ub.maybeSingle = async () => next();
    ub.then = (res: (v: Result) => unknown) => Promise.resolve(next()).then(res);
    state.updates.push({ payload, filters });
    return ub;
  };
  b.single = async () => next();
  b.maybeSingle = async () => next();
  b.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(next()).then(res, rej);
  (b as { _state?: TableState })._state = state;
  return b;
}

function fakeDb(tables: Record<string, ReturnType<typeof fakeTable>>) {
  return { from: (t: string) => tables[t] ?? fakeTable() } as unknown as SupabaseClient;
}
const stateOf = (t: ReturnType<typeof fakeTable>) => (t as unknown as { _state: TableState })._state;

const actor = { id: "user-1", role: "sysadmin" };
const contentTable = () => fakeTable();
const row = (over: Partial<SiteContentRow> = {}): SiteContentRow => ({
  id: "c-1", site_key: "apex", page_key: "home", field_key: "hero_eyebrow", locale: "en",
  draft_value: null, published_value: null, status: "draft", scheduled_at: null,
  version: 0, updated_by: null, created_at: "", updated_at: "", ...over,
});

/* ── Registry + catalog ────────────────────────────────────────────────────── */

describe("site registry", () => {
  it("lists the 7 hosts with public/private classification", () => {
    expect(SITE_REGISTRY).toHaveLength(7);
    expect(SITE_REGISTRY.filter((s) => s.classification === "public").map((s) => s.key)).toEqual(["apex", "support"]);
    for (const s of SITE_REGISTRY) expect(isSiteKey(s.key)).toBe(true);
    expect(isSiteKey("nope")).toBe(false);
  });

  it("catalog only contains rendered fields; unknown lookups return null/empty", () => {
    expect(catalogPages("apex")).toEqual(["home", "global", "footer"]);
    expect(catalogFields("internal", "admin")).toEqual([]);
    expect(catalogPageExists("apex", "home")).toBe(true);
    expect(catalogPageExists("apex", "nope")).toBe(false);
    expect(catalogField("apex", "home", "hero_eyebrow")?.type).toBe("string");
    expect(catalogField("apex", "home", "<script>")).toBeNull();
    expect(catalogField("apex", "home", "admin_panel")).toBeNull();
    // every catalog page belongs to a registry site
    for (const site of Object.keys(FIELD_CATALOG)) expect(isSiteKey(site)).toBe(true);
  });
});

/* ── Validation ────────────────────────────────────────────────────────────── */

const def = (type: FieldDef["type"], extra: Partial<FieldDef> = {}): FieldDef =>
  ({ key: "x", label: "x", type, ...extra });

describe("validateFieldValue", () => {
  it("strips angle brackets from text — no HTML survives", () => {
    const r = validateFieldValue(def("string"), "<script>alert(1)</script>Hello<b>");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).not.toMatch(/[<>]/);
      expect(String(r.value)).toContain("alert(1)"); // text kept, markup gone
    }
    const img = validateFieldValue(def("string"), "<img src=x onerror=alert(1)>");
    if (img.ok) expect(String(img.value)).not.toMatch(/[<>]/);
  });

  it("enforces text length caps", () => {
    expect(validateFieldValue(def("string", { maxLength: 5 }), "123456").ok).toBe(false);
    expect(validateFieldValue(def("string", { maxLength: 5 }), "12345").ok).toBe(true);
    expect(validateFieldValue(def("string"), 42).ok).toBe(false);
  });

  it("rejects non-https / non-relative URLs", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.com/x", "http://insecure.com", "ht tp://x"]) {
      expect(validateFieldValue(def("url"), bad).ok).toBe(false);
    }
    for (const good of ["https://zapnivo.com/x?y=1", "/locations", ""]) {
      expect(validateFieldValue(def("url"), good).ok).toBe(true);
    }
  });

  it("validates booleans strictly", () => {
    expect(validateFieldValue(def("boolean"), true).ok).toBe(true);
    expect(validateFieldValue(def("boolean"), "true").ok).toBe(false);
    expect(validateFieldValue(def("boolean"), 1).ok).toBe(false);
  });

  it("enforces email format when requested", () => {
    const email = def("string", { format: "email" });
    expect(validateFieldValue(email, "team@zapnivo.com").ok).toBe(true);
    expect(validateFieldValue(email, "not-an-email").ok).toBe(false);
    expect(validateFieldValue(email, "a@b").ok).toBe(false);
    expect(validateFieldValue(email, "").ok).toBe(true); // empty = unset
  });

  it("image fields require /images/ path or registered media", () => {
    const img = def("image");
    expect(validateFieldValue(img, "/images/hero.png").ok).toBe(true);
    expect(validateFieldValue(img, "https://evil.com/x.png").ok).toBe(false);
    expect(validateFieldValue(img, "javascript:x").ok).toBe(false);
    const registered = new Set(["cms-media/hero.webp", "https://cdn.example.com/hero.webp"]);
    expect(validateFieldValue(img, "cms-media/hero.webp", registered).ok).toBe(true);
    expect(validateFieldValue(img, "cms-media/other.webp", registered).ok).toBe(false);
  });
});

/* ── Draft → publish → revert chain ────────────────────────────────────────── */

describe("content lifecycle", () => {
  it("saveDraft upserts sanitized draft + writes save_draft revision + audit", async () => {
    const content = contentTable();
    const revisions = fakeTable();
    const audit = fakeTable();
    const db = fakeDb({ site_content: content, site_content_revisions: revisions, system_audit_events: audit });
    stateOf(content).queue.push(
      { data: null, error: null }, // getContentRow → no existing
      { data: row({ draft_value: "bhi/b", version: 1, status: "draft" }), error: null }, // upsert().single()
    );

    const res = await saveDraft(db, actor, {
      siteKey: "apex", pageKey: "home", fieldKey: "hero_eyebrow", value: "<b>hi</b>",
    });
    expect(res.ok).toBe(true);
    const up = stateOf(content).upserted[0];
    expect(up.payload).toMatchObject({ draft_value: "bhi/b", status: "draft", version: 1 });
    expect(up.onConflict).toBe("site_key,page_key,field_key,locale");
    expect(stateOf(revisions).inserted[0]).toMatchObject({ action: "save_draft", version: 1 });
    expect(stateOf(audit).inserted[0]).toMatchObject({ action: "sitecms.draft_saved" });
  });

  it("unknown field → 404, invalid value → 422, nothing written", async () => {
    const content = contentTable();
    const db = fakeDb({ site_content: content });
    const bad = await saveDraft(db, actor, { siteKey: "apex", pageKey: "home", fieldKey: "nope", value: "x" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(404);
    const content2 = contentTable();
    const db2 = fakeDb({ site_content: content2 });
    stateOf(content2).queue.push({ data: null, error: null });
    const badUrl = await saveDraft(db2, actor, {
      siteKey: "apex", pageKey: "global", fieldKey: "announcement_href", value: "javascript:alert(1)",
    });
    expect(badUrl.ok).toBe(false);
    if (!badUrl.ok) expect(badUrl.status).toBe(422);
    expect(stateOf(content2).upserted).toHaveLength(0);
  });

  it("publishDraft copies draft → published, status published, revision + audit", async () => {
    const content = contentTable();
    const revisions = fakeTable();
    const db = fakeDb({ site_content: content, site_content_revisions: revisions, system_audit_events: fakeTable() });
    stateOf(content).queue.push(
      { data: row({ draft_value: "New headline", version: 3, status: "draft" }), error: null }, // getContentRow
      { data: row({ draft_value: "New headline", published_value: "New headline", version: 4, status: "published" }), error: null }, // update().single()
    );
    const res = await publishDraft(db, actor, { siteKey: "apex", pageKey: "home", fieldKey: "hero_eyebrow" });
    expect(res.ok).toBe(true);
    expect(stateOf(revisions).inserted[0]).toMatchObject({ action: "publish", version: 4, value: "New headline" });
  });

  it("publish with no draft → 409", async () => {
    const content = contentTable();
    const db = fakeDb({ site_content: content });
    stateOf(content).queue.push({ data: row({ draft_value: null }), error: null });
    const res = await publishDraft(db, actor, { siteKey: "apex", pageKey: "home", fieldKey: "hero_eyebrow" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it("schedulePublish snapshots draft, requires future time", async () => {
    const content = contentTable();
    const revisions = fakeTable();
    const db = fakeDb({ site_content: content, site_content_revisions: revisions, system_audit_events: fakeTable() });
    stateOf(content).queue.push(
      { data: row({ draft_value: "Soon", version: 1 }), error: null },
      { data: row({ draft_value: "Soon", published_value: "Soon", version: 2, status: "scheduled" }), error: null },
    );
    const future = new Date(Date.now() + 3600_000).toISOString();
    const res = await schedulePublish(db, actor, { siteKey: "apex", pageKey: "home", fieldKey: "hero_eyebrow", scheduledAt: future });
    expect(res.ok).toBe(true);
    expect(stateOf(revisions).inserted[0]).toMatchObject({ action: "schedule" });

    const content2 = contentTable();
    const db2 = fakeDb({ site_content: content2 });
    stateOf(content2).queue.push({ data: row({ draft_value: "x" }), error: null });
    const past = await schedulePublish(db2, actor, {
      siteKey: "apex", pageKey: "home", fieldKey: "hero_eyebrow", scheduledAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.status).toBe(422);
  });

  it("revertToRevision restores published_value from the revision and audits", async () => {
    const revisions = fakeTable();
    const content = contentTable();
    const db = fakeDb({ site_content_revisions: revisions, site_content: content, system_audit_events: fakeTable() });
    const rev: ContentRevision = {
      id: "11111111-1111-1111-1111-111111111111", content_id: "c-1", version: 2,
      value: "Old headline", action: "publish", actor: "user-1", created_at: "",
    };
    stateOf(revisions).queue.push({ data: rev, error: null }); // revision lookup
    stateOf(content).queue.push(
      { data: row({ version: 5, status: "published" }), error: null }, // content row lookup
      { data: row({ version: 6, status: "published", published_value: "Old headline" }), error: null }, // update().single()
    );
    const res = await revertToRevision(db, actor, { siteKey: "apex", revisionId: rev.id });
    expect(res.ok).toBe(true);
    // revert wrote a 'revert' revision on site_content_revisions — same table queue continues
    const revInserts = stateOf(revisions).inserted;
    expect(revInserts[revInserts.length - 1]).toMatchObject({ action: "revert", value: "Old headline" });
  });

  it("revert rejects revisions from another site", async () => {
    const revisions = fakeTable();
    const content = contentTable();
    const db = fakeDb({ site_content_revisions: revisions, site_content: content });
    stateOf(revisions).queue.push({
      data: { id: "r1", content_id: "c-9", version: 1, value: "x", action: "publish", actor: null, created_at: "" },
      error: null,
    });
    stateOf(content).queue.push({ data: row({ site_key: "support" }), error: null });
    const res = await revertToRevision(db, actor, { siteKey: "apex", revisionId: "11111111-1111-1111-1111-111111111111" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });
});

/* ── Permission gates (documented mapping — rbac.ts union is not editable) ─── */

describe("permission mapping", () => {
  const user = { id: "u", email: "u@x.com", role: "admin", organizationId: null } as const;
  it("viewer can read but cannot manage or publish", () => {
    expect(authorize(user, "viewer", "system.dashboard.view").ok).toBe(true);
    expect(authorize(user, "viewer", "system.flags.manage").ok).toBe(false);
    expect(authorize(user, "viewer", "system.deployments.manage").ok).toBe(false);
  });
  it("developer can draft + publish; hardware/security cannot publish", () => {
    expect(roleCan("developer", "system.flags.manage")).toBe(true);
    expect(roleCan("developer", "system.deployments.manage")).toBe(true);
    expect(roleCan("hardware", "system.flags.manage")).toBe(false);
    expect(roleCan("security", "system.deployments.manage")).toBe(false);
    expect(roleCan("sysadmin", "system.deployments.manage")).toBe(true);
  });
});
