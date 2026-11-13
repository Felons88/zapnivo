import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createRedirect, deleteRedirect, isAllowedRedirectHost, listRedirects,
  updateRedirect, validateFromPath, validateToPath,
} from "@/lib/system/site-ops";
import { getPublicMaintenanceNotice, resetMaintenanceNoticeCache } from "@/lib/maintenance-notice";
import type { SessionUser } from "@/lib/auth";

/* ── Minimal Supabase stub (same pattern as tests/system-emergency.test.ts) ── */
type Result = { data?: unknown; error?: { message: string; code?: string } | null };
function fakeTable(opts: { list?: Result; singles?: Result[] } = {}) {
  const singles = [...(opts.singles ?? [])];
  const b: Record<string, unknown> & { _insert?: unknown; _update?: unknown; _delete?: unknown } = {};
  const next = (): Result => (singles.length ? singles.shift()! : { data: null, error: null });
  for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "insert", "update", "upsert", "delete", "filter", "like", "gte", "lt"]) {
    b[m] = (...a: unknown[]) => {
      if (m === "insert") b._insert = a[0];
      if (m === "update") b._update = a[0];
      return b;
    };
  }
  b.single = async () => next();
  b.maybeSingle = async () => next();
  b.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(opts.list ?? { data: [], error: null }).then(res, rej);
  return b;
}
function fakeDb(tables: Record<string, ReturnType<typeof fakeTable>>) {
  const calls: string[] = [];
  const db = {
    from: (t: string) => {
      calls.push(t);
      return tables[t] ?? fakeTable();
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

const user = (): SessionUser => ({ id: "op-1", email: "op@zapnivo.com", role: "staff", organizationId: null });
const actor = { id: "op-1", role: "sysadmin" };
const ID = "22222222-2222-4222-8222-222222222222";

describe("redirect path validation", () => {
  it("accepts clean relative from_paths", () => {
    for (const p of ["/old-page", "/blog/post-1", "/a/b?x=1", "/stations"]) {
      expect(validateFromPath(p)).toEqual({ ok: true, value: p });
    }
  });

  it("rejects bad from_paths", () => {
    for (const p of ["", "old-page", "//evil.com", "/a b", "/x/../y", "https://x.com", "javascript:alert(1)", "  "]) {
      expect(validateFromPath(p).ok, JSON.stringify(p)).toBe(false);
    }
    expect(validateFromPath(42).ok).toBe(false);
  });

  it("to_path accepts relative paths and same-host https URLs", () => {
    expect(validateToPath("/new-place")).toEqual({ ok: true, value: "/new-place" });
    expect(validateToPath("https://zapnivo.com/pricing").ok).toBe(true);
    expect(validateToPath("https://support.zapnivo.com/help").ok).toBe(true);
    expect(validateToPath("https://partners.zapnivo.com/apply").ok).toBe(true);
    expect(validateToPath("http://localhost:3000/dev").ok).toBe(true);
    expect(validateToPath("https://app.localhost/x").ok).toBe(true);
  });

  it("to_path rejects arbitrary external hosts and unsafe schemes", () => {
    for (const p of [
      "https://evil.com/x",
      "https://zapnivo.com.evil.com/x",
      "http://zapnivo.com/x",
      "javascript:alert(1)",
      "//evil.com/path",
      "ftp://zapnivo.com/x",
      "data:text/html,x",
      "not a url at all",
    ]) {
      expect(validateToPath(p).ok, p).toBe(false);
    }
  });

  it("isAllowedRedirectHost covers apex, subdomains, and localhost only", () => {
    expect(isAllowedRedirectHost("zapnivo.com")).toBe(true);
    expect(isAllowedRedirectHost("support.zapnivo.com")).toBe(true);
    expect(isAllowedRedirectHost("localhost")).toBe(true);
    expect(isAllowedRedirectHost("foo.localhost")).toBe(true);
    expect(isAllowedRedirectHost("evilzapnivo.com")).toBe(false);
    expect(isAllowedRedirectHost("zapnivo.com.evil.com")).toBe(false);
  });
});

describe("redirect CRUD", () => {
  const valid = { site_key: "apex", from_path: "/old", to_path: "/new" };

  it("503 without backend, 400 on bad input before any gate", async () => {
    expect(await createRedirect(null, user(), actor, valid, "reason long enough")).toMatchObject({ ok: false, status: 503 });
    const { db } = fakeDb({});
    expect(await createRedirect(db, user(), actor, { ...valid, site_key: "nope" }, "reason long enough")).toMatchObject({ ok: false, status: 400 });
    expect(await createRedirect(db, user(), actor, { ...valid, from_path: "bad" }, "reason long enough")).toMatchObject({ ok: false, status: 400 });
    expect(await createRedirect(db, user(), actor, { ...valid, to_path: "https://evil.com" }, "reason long enough")).toMatchObject({ ok: false, status: 400 });
    expect(await createRedirect(db, user(), actor, { ...valid, to_path: "/old" }, "reason long enough")).toMatchObject({ ok: false, status: 400 });
    expect(await createRedirect(db, null, actor, valid, "reason long enough")).toMatchObject({ ok: false, status: 401 });
  });

  it("creates a redirect and audits siteops.redirect_created", async () => {
    const redirects = fakeTable({ singles: [{ data: { id: ID }, error: null }] });
    const audits = fakeTable();
    const { db } = fakeDb({ site_redirects: redirects, system_audit_events: audits });
    const res = await createRedirect(db, user(), actor, { ...valid, note: "campaign cleanup" }, "marketing redirect cleanup INC-1");
    expect(res).toMatchObject({ ok: true, id: ID });
    const ins = redirects._insert as Record<string, unknown>;
    expect(ins.site_key).toBe("apex");
    expect(ins.from_path).toBe("/old");
    expect(ins.to_path).toBe("/new");
    expect(ins.created_by).toBe("op-1");
  });

  it("maps unique-violation to 409", async () => {
    const redirects = fakeTable({ singles: [{ data: null, error: { message: "dup", code: "23505" } }] });
    const { db } = fakeDb({ site_redirects: redirects });
    const res = await createRedirect(db, user(), actor, valid, "reason long enough");
    expect(res).toMatchObject({ ok: false, status: 409 });
  });

  it("updates to_path/enabled and deletes by id", async () => {
    const redirects = fakeTable({ singles: [{ data: { id: ID }, error: null }, { data: { id: ID }, error: null }] });
    const { db } = fakeDb({ site_redirects: redirects });
    const upd = await updateRedirect(db, user(), actor, ID, { to_path: "https://support.zapnivo.com/x", enabled: false }, "retarget redirect");
    expect(upd.ok).toBe(true);
    const u = redirects._update as Record<string, unknown>;
    expect(u.to_path).toBe("https://support.zapnivo.com/x");
    expect(u.enabled).toBe(false);

    const del = await deleteRedirect(db, user(), actor, ID, "remove stale redirect");
    expect(del).toMatchObject({ ok: true, id: ID });

    expect(await updateRedirect(db, user(), actor, "bad-id", { enabled: true }, "reason long enough")).toMatchObject({ ok: false, status: 400 });
    expect(await deleteRedirect(db, user(), actor, "bad-id", "reason long enough")).toMatchObject({ ok: false, status: 400 });
  });

  it("update rejects external to_path", async () => {
    const { db } = fakeDb({});
    const res = await updateRedirect(db, user(), actor, ID, { to_path: "https://phish.example.com" }, "reason long enough");
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it("listRedirects returns [] without backend and rows with one", async () => {
    expect(await listRedirects(null)).toEqual([]);
    const row = { id: ID, site_key: "apex", from_path: "/a", to_path: "/b", enabled: true, note: null, created_by: "op-1", created_at: "", updated_at: "" };
    const redirects = fakeTable({ list: { data: [row], error: null } });
    const { db } = fakeDb({ site_redirects: redirects });
    expect(await listRedirects(db, "apex")).toHaveLength(1);
  });
});

describe("public maintenance notice reader", () => {
  it("returns null when backend is unconfigured and caches safely", async () => {
    resetMaintenanceNoticeCache();
    // No Supabase env in tests → serviceClient() null → honest null.
    expect(await getPublicMaintenanceNotice()).toBeNull();
    expect(await getPublicMaintenanceNotice()).toBeNull();
    resetMaintenanceNoticeCache();
  });
});
