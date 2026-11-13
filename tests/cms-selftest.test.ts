import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * CMS self-test: verifies step ordering, the same-value guarantee, the
 * '<script>' rejection probe, pending-draft/schedule skipping, and the
 * conditional restore. site-cms mutation/read functions are mocked; the
 * catalog + validation stay real.
 */

const mocks = vi.hoisted(() => ({
  saveDraft: vi.fn(),
  publishDraft: vi.fn(),
  revertToRevision: vi.fn(),
  getContentRow: vi.fn(),
}));
const { saveDraft, publishDraft, revertToRevision, getContentRow } = mocks;

vi.mock("@/lib/system/site-cms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/system/site-cms")>();
  return {
    ...actual,
    saveDraft: (...a: unknown[]) => mocks.saveDraft(...a),
    publishDraft: (...a: unknown[]) => mocks.publishDraft(...a),
    revertToRevision: (...a: unknown[]) => mocks.revertToRevision(...a),
    getContentRow: (...a: unknown[]) => mocks.getContentRow(...a),
  };
});

import { runCmsSelftest } from "@/lib/system/cms-selftest";

/* ── Minimal db stub: only site_content_revisions (restore lookup) and
      system_audit_events (audit writes) are hit directly. ─────────────── */

type Result = { data?: unknown; error?: { message: string } | null };

function fakeTable(queue: Result[] = []) {
  const inserted: unknown[] = [];
  const q = [...queue];
  const next = (): Result => (q.length ? q.shift()! : { data: null, error: null });
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "not", "order", "limit", "insert"]) {
    b[m] = m === "insert" ? (row: unknown) => { inserted.push(row); return b; } : () => b;
  }
  b.maybeSingle = async () => next();
  b.single = async () => next();
  b.then = (res: (v: Result) => unknown) => Promise.resolve(next()).then(res);
  (b as { _inserted?: unknown[] })._inserted = inserted;
  return b;
}

function fakeDb(tables: Record<string, ReturnType<typeof fakeTable>>) {
  return { from: (t: string) => tables[t] ?? fakeTable() } as unknown as SupabaseClient;
}

const actor = { id: "user-1", role: "sysadmin" };

const contentRow = (over: Record<string, unknown> = {}) => ({
  id: "c-1",
  site_key: "apex",
  page_key: "footer",
  field_key: "contact_email",
  locale: "en",
  draft_value: "ops@zapnivo.com",
  published_value: "ops@zapnivo.com",
  status: "published",
  scheduled_at: null,
  version: 3,
  updated_by: null,
  created_at: "",
  updated_at: "",
  ...over,
});

const XSS = "<script>alert(1)</script>";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: XSS probe rejected; same-value draft/publish succeed.
  saveDraft.mockImplementation((_db: unknown, _a: unknown, input: { value: unknown }) =>
    input.value === XSS
      ? Promise.resolve({ ok: false, status: 422, error: "Invalid email address" })
      : Promise.resolve({ ok: true, data: contentRow({ version: 4 }) }),
  );
  publishDraft.mockResolvedValue({ ok: true, data: contentRow({ version: 5, status: "published" }) });
  revertToRevision.mockResolvedValue({ ok: true, data: contentRow({ version: 6 }) });
});

describe("runCmsSelftest — happy path", () => {
  it("runs field_selection → xss → save_draft → publish → verify → restore in order", async () => {
    getContentRow
      .mockResolvedValueOnce(contentRow()) // field selection
      .mockResolvedValueOnce(contentRow({ version: 5, status: "published" })); // verify
    const revisions = fakeTable([{ data: { id: "rev-9", value: "ops@zapnivo.com" }, error: null }]);
    const audit = fakeTable();
    const db = fakeDb({ site_content_revisions: revisions, system_audit_events: audit });

    const res = await runCmsSelftest(db, actor);

    expect(res.ok).toBe(true);
    expect(res.steps.map((s) => s.step)).toEqual([
      "field_selection",
      "xss_validation",
      "save_draft",
      "publish",
      "verify_published",
      "restore",
    ]);
    expect(res.field).toEqual({ site_key: "apex", page_key: "footer", field_key: "contact_email" });

    // Same-value guarantee: the draft written equals the published baseline.
    const draftCalls = saveDraft.mock.calls.filter((c) => (c[2] as { value: unknown }).value !== XSS);
    expect(draftCalls).toHaveLength(1);
    expect((draftCalls[0][2] as { value: unknown }).value).toBe("ops@zapnivo.com");

    // XSS probe went through saveDraft and was rejected.
    const probeCall = saveDraft.mock.calls.find((c) => (c[2] as { value: unknown }).value === XSS);
    expect(probeCall).toBeTruthy();

    expect(publishDraft).toHaveBeenCalledTimes(1);
    expect(revertToRevision).toHaveBeenCalledWith(db, actor, { siteKey: "apex", revisionId: "rev-9" });

    // Audit 'cms.selftest' written.
    const auditInserts = (audit as unknown as { _inserted: { action?: string }[] })._inserted;
    expect(auditInserts.some((r) => r.action === "cms.selftest")).toBe(true);
  });

  it("empty catalog: publishes '' (code-default equivalent) and skips revert", async () => {
    getContentRow
      .mockResolvedValueOnce(null) // no row at selection
      .mockResolvedValueOnce(contentRow({ published_value: "", draft_value: "", version: 1, status: "published" }));
    const db = fakeDb({ site_content_revisions: fakeTable(), system_audit_events: fakeTable() });

    const res = await runCmsSelftest(db, actor);
    expect(res.ok).toBe(true);
    const draftCall = saveDraft.mock.calls.find((c) => (c[2] as { value: unknown }).value !== XSS);
    expect((draftCall![2] as { value: unknown }).value).toBe("");
    expect(revertToRevision).not.toHaveBeenCalled();
    expect(res.steps.find((s) => s.step === "restore")?.detail).toMatch(/no prior CMS row/);
  });
});

describe("runCmsSelftest — safety skips", () => {
  it("skips a field with an unpublished pending draft and falls back to the next candidate", async () => {
    getContentRow
      .mockResolvedValueOnce(contentRow({ draft_value: "unpublished work", published_value: "ops@zapnivo.com" })) // footer: pending draft → skip
      .mockResolvedValueOnce(null) // announcement_href: no row → chosen
      .mockResolvedValueOnce(contentRow({ site_key: "apex", page_key: "global", field_key: "announcement_href", published_value: "", draft_value: "", version: 1 })); // verify

    const db = fakeDb({ site_content_revisions: fakeTable(), system_audit_events: fakeTable() });
    const res = await runCmsSelftest(db, actor);

    expect(res.ok).toBe(true);
    expect(res.field).toEqual({ site_key: "apex", page_key: "global", field_key: "announcement_href" });
    expect(res.notes.some((n) => n.includes("unpublished draft"))).toBe(true);
    const draftCall = saveDraft.mock.calls.find((c) => (c[2] as { value: unknown }).value !== XSS);
    expect((draftCall![2] as { pageKey: string }).pageKey).toBe("global");
  });

  it("fails honestly when every candidate is unsafe — no writes attempted", async () => {
    getContentRow.mockResolvedValue(contentRow({ status: "scheduled", scheduled_at: new Date(Date.now() + 60_000).toISOString() }));
    const db = fakeDb({});
    const res = await runCmsSelftest(db, actor);
    expect(res.ok).toBe(false);
    expect(saveDraft).not.toHaveBeenCalled();
    expect(publishDraft).not.toHaveBeenCalled();
  });
});

describe("runCmsSelftest — failure paths", () => {
  it("aborts and restores the draft when the XSS probe is unexpectedly accepted", async () => {
    saveDraft.mockResolvedValue({ ok: true, data: contentRow({ draft_value: "scriptalert(1)script" }) });
    getContentRow.mockResolvedValue(contentRow());
    const db = fakeDb({ system_audit_events: fakeTable() });

    const res = await runCmsSelftest(db, actor);
    expect(res.ok).toBe(false);
    expect(res.steps.map((s) => s.step)).toContain("draft_restore");
    expect(publishDraft).not.toHaveBeenCalled();
    // restore attempt wrote the baseline value back as a draft
    const lastCall = saveDraft.mock.calls[saveDraft.mock.calls.length - 1];
    expect((lastCall[2] as { value: unknown }).value).toBe("ops@zapnivo.com");
  });

  it("fails when publishDraft errors", async () => {
    getContentRow.mockResolvedValue(contentRow());
    publishDraft.mockResolvedValue({ ok: false, status: 500, error: "publish failed" });
    const db = fakeDb({ site_content_revisions: fakeTable(), system_audit_events: fakeTable() });
    const res = await runCmsSelftest(db, actor);
    expect(res.ok).toBe(false);
    expect(res.steps.find((s) => s.step === "publish")?.ok).toBe(false);
  });

  it("returns failure without throwing when db is null", async () => {
    const res = await runCmsSelftest(null, actor);
    expect(res.ok).toBe(false);
    expect(res.steps[0].step).toBe("backend");
  });
});
