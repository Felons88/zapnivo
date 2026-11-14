import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionUser } from "@/lib/auth";
import {
  approveRelease, createReleaseDraft, deprecateRelease, getRelease,
  listReleases, registerArtifactMetadata, revokeRelease, updateReleaseMetadata,
  RELEASE_TRANSITIONS, UPDATE_BUCKET, type KioskUpdateRelease,
} from "@/lib/system/update-releases";

/**
 * Kiosk update release registry (migration 0067). In-memory Supabase stub —
 * same philosophy as system-device-config.test.ts. The DB-level immutability
 * trigger / check constraints are NOT simulated here; app-level guards are.
 */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  const eqv = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const cmp = (a: unknown, b: unknown) => String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;

  class QB {
    private op: "select" | "insert" | "update" = "select";
    private payload: unknown = null;
    private filters: ((r: Row) => boolean)[] = [];
    private orderBy: { col: string; asc: boolean } | null = null;
    private lim: number | null = null;
    constructor(private name: string) {}
    select() { return this; }
    insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
    update(p: unknown) { this.op = "update"; this.payload = p; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
    order(c: string, o?: { ascending?: boolean }) { this.orderBy = { col: c, asc: o?.ascending !== false }; return this; }
    limit(n: number) { this.lim = n; return this; }

    private run() {
      const rows = ensure(this.name);
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert") {
        const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        const out: Row[] = [];
        for (const item of items) {
          const row: Row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...item };
          rows.push(row); out.push(row);
        }
        return { data: out, error: null };
      }
      if (this.op === "update") {
        const affected = rows.filter(match);
        for (const r of affected) Object.assign(r, this.payload as Row);
        return { data: affected, error: null };
      }
      let out = rows.filter(match);
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        out = [...out].sort((a, b) => (asc ? cmp(a[col], b[col]) : -cmp(a[col], b[col])));
      }
      if (this.lim != null) out = out.slice(0, this.lim);
      return { data: out, error: null };
    }
    private finish() { return this.run(); }
    single() {
      const { data } = this.finish();
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return { data: rows[0] ?? null, error: null };
    }
    maybeSingle() {
      const { data } = this.finish();
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return { data: rows[0] ?? null, error: null };
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.finish()).then(onF, onR);
    }
  }
  return { db: { from: (t: string) => new QB(t) } as unknown as SupabaseClient, tables };
}

const ACTOR = { id: "11111111-1111-4111-8111-111111111111", role: "sysadmin" };
const USER = { id: ACTOR.id, email: "ops@zapnivo.test", role: "admin", organizationId: null } as unknown as SessionUser;
const SHA = "a".repeat(64);

const relRow = (over: Row = {}): Row => ({
  id: crypto.randomUUID(), kind: "config", version: "1.0.0", channel: "stable",
  manufacturer: null, model: null, hw_revision_min: null,
  storage_bucket: null, storage_path: null, sha256: null,
  signature_status: "unsigned", signature_key_id: null, release_notes: null,
  status: "draft", uploaded_by: ACTOR.id, approved_by: null, approved_at: null,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

const elevationRow = (profileId: string, over: Row = {}): Row => ({
  id: crypto.randomUUID(), profile_id: profileId, method: "totp",
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  consumed_action: null, created_ip: null,
  ...over,
});

const auditActions = (tables: Record<string, Row[]>) =>
  (tables["system_audit_events"] ?? []).map((r) => r.action as string);

describe("createReleaseDraft — validation", () => {
  it("rejects bad sha256 and unknown fields", async () => {
    const { db } = fakeDb();
    const bad = await createReleaseDraft(db, ACTOR, { kind: "firmware", version: "1.0", sha256: "not-hex" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(400);
    const extra = await createReleaseDraft(db, ACTOR, { kind: "config", version: "1.0", evil: true });
    expect(extra.ok).toBe(false);
  });

  it("creates a draft with defaults and audits", async () => {
    const { db, tables } = fakeDb();
    const r = await createReleaseDraft(db, ACTOR, { kind: "config", version: "2.1.0", channel: "beta", release_notes: "notes" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.release.status).toBe("draft");
      expect(r.release.signature_status).toBe("unsigned");
      expect(r.release.uploaded_by).toBe(ACTOR.id);
    }
    expect(auditActions(tables)).toContain("update.release.created");
  });
});

describe("approveRelease — gates", () => {
  it("firmware requires signature_status='verified'", async () => {
    const { db, tables } = fakeDb({ kiosk_update_releases: [relRow({ kind: "firmware", signature_status: "signed" })] });
    const id = (tables["kiosk_update_releases"][0] as Row).id as string;
    const r = await approveRelease(db, ACTOR, id, USER);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.error).toContain("verified");
    }
  });

  it("firmware with verified signature still needs step-up elevation", async () => {
    const { db } = fakeDb({ kiosk_update_releases: [relRow({ kind: "firmware", signature_status: "verified" })] });
    const id = (await listReleases(db)).releases[0].id;
    const r = await approveRelease(db, ACTOR, id, USER);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.code).toBe("step_up_required");
    }
  });

  it("firmware approves with verified signature + live elevation", async () => {
    const row = relRow({ kind: "firmware", signature_status: "verified", version: "3.0.0" });
    const { db, tables } = fakeDb({
      kiosk_update_releases: [row],
      system_elevations: [elevationRow(USER.id)],
    });
    const r = await approveRelease(db, ACTOR, row.id as string, USER);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.release.status).toBe("approved");
      expect(r.release.approved_by).toBe(ACTOR.id);
      expect(r.release.approved_at).toBeTruthy();
    }
    expect(auditActions(tables)).toContain("update.release.approved");
  });

  it("software is also gated; config is exempt from both gates", async () => {
    const sw = relRow({ kind: "software", signature_status: "verified" });
    const cfg = relRow({ kind: "config", version: "9.9.9" });
    const { db } = fakeDb({ kiosk_update_releases: [sw, cfg] });
    const swRes = await approveRelease(db, ACTOR, sw.id as string, USER);
    expect(swRes.ok).toBe(false);
    if (!swRes.ok) expect(swRes.code).toBe("step_up_required");
    const cfgRes = await approveRelease(db, ACTOR, cfg.id as string, USER);
    expect(cfgRes.ok).toBe(true);
  });

  it("rejects approving a non-draft release", async () => {
    const row = relRow({ status: "approved", kind: "config" });
    const { db } = fakeDb({ kiosk_update_releases: [row] });
    const r = await approveRelease(db, ACTOR, row.id as string, USER);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });
});

describe("status transitions", () => {
  it("deprecate only from approved; revoke from draft or approved; terminals block all", async () => {
    const approved = relRow({ status: "approved", kind: "config" });
    const draft = relRow({ kind: "config", version: "1.1.0" });
    const { db, tables } = fakeDb({ kiosk_update_releases: [approved, draft] });

    // draft → deprecated is illegal
    const badDep = await deprecateRelease(db, ACTOR, draft.id as string);
    expect(badDep.ok).toBe(false);
    if (!badDep.ok) expect(badDep.status).toBe(409);

    // approved → deprecated ok
    const dep = await deprecateRelease(db, ACTOR, approved.id as string);
    expect(dep.ok).toBe(true);

    // deprecated is terminal — revoke now fails
    const after = await revokeRelease(db, ACTOR, approved.id as string);
    expect(after.ok).toBe(false);

    // draft → revoked ok
    const rev = await revokeRelease(db, ACTOR, draft.id as string);
    expect(rev.ok).toBe(true);
    if (rev.ok) expect(rev.release.status).toBe("revoked");

    expect(auditActions(tables)).toEqual(expect.arrayContaining([
      "update.release.deprecated", "update.release.revoked",
    ]));
    // transition map sanity: deprecated/revoked have no outgoing edges
    expect(RELEASE_TRANSITIONS.deprecated).toEqual([]);
    expect(RELEASE_TRANSITIONS.revoked).toEqual([]);
  });
});

describe("metadata + artifact registration", () => {
  it("updateReleaseMetadata works on drafts, refuses non-drafts (immutability)", async () => {
    const draft = relRow({ kind: "config" });
    const approved = relRow({ status: "approved", kind: "config", version: "2.0.0" });
    const { db, tables } = fakeDb({ kiosk_update_releases: [draft, approved] });

    const okRes = await updateReleaseMetadata(db, ACTOR, draft.id as string, { release_notes: "fixed" });
    expect(okRes.ok).toBe(true);

    const frozen = await updateReleaseMetadata(db, ACTOR, approved.id as string, { release_notes: "tamper" });
    expect(frozen.ok).toBe(false);
    if (!frozen.ok) expect(frozen.status).toBe(409);

    // sha256 format enforced on metadata too
    const badSha = await updateReleaseMetadata(db, ACTOR, draft.id as string, { sha256: "xyz" });
    expect(badSha.ok).toBe(false);
    expect(auditActions(tables)).toContain("update.release.metadata_updated");
  });

  it("registerArtifactMetadata defaults to the private kiosk-updates bucket", async () => {
    const draft = relRow({ kind: "config" });
    const { db } = fakeDb({ kiosk_update_releases: [draft] });
    const r = await registerArtifactMetadata(db, ACTOR, draft.id as string, {
      storage_path: "releases/config/1.0.0.json", sha256: SHA, signature_status: "signed",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.release.storage_bucket).toBe(UPDATE_BUCKET);
      expect(r.release.storage_path).toBe("releases/config/1.0.0.json");
      expect(r.release.sha256).toBe(SHA);
    }
    const bad = await registerArtifactMetadata(db, ACTOR, draft.id as string, {
      storage_path: "x", sha256: "short",
    });
    expect(bad.ok).toBe(false);
  });
});

describe("reads", () => {
  it("listReleases filters by kind/status and getRelease round-trips", async () => {
    const a = relRow({ kind: "firmware", status: "draft" });
    const b = relRow({ kind: "config", status: "approved", version: "4.0.0" });
    const { db } = fakeDb({ kiosk_update_releases: [a, b] });

    const all = await listReleases(db);
    expect(all.releases).toHaveLength(2);
    const fw = await listReleases(db, { kind: "firmware" });
    expect(fw.releases).toHaveLength(1);
    const appr = await listReleases(db, { status: "approved" });
    expect(appr.releases).toHaveLength(1);
    expect(appr.releases[0].version).toBe("4.0.0");

    const got = await getRelease(db, a.id as string);
    expect(got?.kind).toBe("firmware");
    expect(await getRelease(db, "not-a-uuid")).toBeNull();
  });
});
