import { describe, expect, it, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  enrollTotp, challengeTotp, verifyTotp, listFactors, unenrollFactor, hasVerifiedTotp,
  type MfaConfig,
} from "@/lib/system/mfa";
import type { SessionUser } from "@/lib/auth";

const CONFIG: MfaConfig = { url: "https://proj.supabase.co", anonKey: "anon-key" };
const TOKEN = "user-access-token";
const user = (id = "u1"): SessionUser => ({ id, email: "op@zapnivo.com", role: "staff", organizationId: null });

/** Minimal fetch stub returning a GoTrue-shaped JSON response. */
const fakeFetch = (status: number, body: unknown, capture?: { url?: string; init?: RequestInit }) =>
  vi.fn(async (url: unknown, init?: RequestInit) => {
    if (capture) { capture.url = String(url); capture.init = init; }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  });

type Result = { data?: unknown; error?: { message: string } | null };
function fakeTable(opts: { list?: Result; singles?: Result[] } = {}) {
  const singles = [...(opts.singles ?? [])];
  const b: Record<string, unknown> & { _insert?: unknown } = {};
  const next = (): Result => singles.length ? singles.shift()! : { data: null, error: null };
  for (const m of ["select", "eq", "neq", "in", "is", "not", "order", "limit", "insert", "update", "upsert", "delete", "filter"]) {
    b[m] = (...a: unknown[]) => { if (m === "insert") b._insert = a[0]; return b; };
  }
  b.single = async () => next();
  b.maybeSingle = async () => next();
  b.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(opts.list ?? { data: [], error: null }).then(res, rej);
  return b;
}
function fakeDb(tables: Record<string, ReturnType<typeof fakeTable>>) {
  const calls: string[] = [];
  const db = { from: (t: string) => { calls.push(t); return tables[t] ?? fakeTable(); } } as unknown as SupabaseClient;
  return { db, calls };
}

afterEach(() => vi.restoreAllMocks());

describe("enrollTotp", () => {
  it("POSTs factor_type=totp and returns secret+uri once (never persisted)", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const f = fakeFetch(200, {
      id: "factor-1", type: "totp",
      totp: { qr_code: "<svg/>", secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" },
    }, cap);
    const res = await enrollTotp(TOKEN, { config: CONFIG, fetchImpl: f as unknown as typeof fetch, friendlyName: "test" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.factorId).toBe("factor-1");
      expect(res.data.secret).toBe("JBSWY3DPEHPK3PXP");
      expect(res.data.uri).toContain("otpauth://");
    }
    expect(cap.url).toBe("https://proj.supabase.co/auth/v1/factors");
    expect(cap.init?.method).toBe("POST");
    const sent = JSON.parse(String(cap.init?.body)) as Record<string, unknown>;
    expect(sent.factor_type).toBe("totp");
    expect((cap.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("fails without config or token", async () => {
    expect(await enrollTotp(TOKEN, { config: null })).toMatchObject({ ok: false });
    expect(await enrollTotp("", { config: CONFIG })).toMatchObject({ ok: false });
  });
});

describe("challengeTotp / listFactors / unenrollFactor", () => {
  it("challenge hits /factors/{id}/challenge", async () => {
    const cap: { url?: string } = {};
    const f = fakeFetch(200, { id: "ch-1", expires_at: new Date().toISOString() }, cap);
    const res = await challengeTotp(TOKEN, "factor-1", { config: CONFIG, fetchImpl: f as unknown as typeof fetch });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.challengeId).toBe("ch-1");
    expect(cap.url).toBe("https://proj.supabase.co/auth/v1/factors/factor-1/challenge");
  });

  it("listFactors normalizes totp factors and verified flag", async () => {
    const f = fakeFetch(200, {
      all: [{ id: "f1", factor_type: "totp", status: "verified" }, { id: "f2", status: "unverified" }],
      totp: [{ id: "f1", factor_type: "totp", status: "verified" }],
      phone: [],
    });
    const res = await listFactors(TOKEN, { config: CONFIG, fetchImpl: f as unknown as typeof fetch });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.totp).toHaveLength(1);
      expect(res.data.totp[0].id).toBe("f1");
    }
    const hv = await hasVerifiedTotp(TOKEN, { config: CONFIG, fetchImpl: f as unknown as typeof fetch });
    expect(hv).toEqual({ ok: true, verified: true });
  });

  it("unenroll DELETEs the factor", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const f = fakeFetch(200, {}, cap);
    const res = await unenrollFactor(TOKEN, "f1", { config: CONFIG, fetchImpl: f as unknown as typeof fetch });
    expect(res.ok).toBe(true);
    expect(cap.url).toBe("https://proj.supabase.co/auth/v1/factors/f1");
    expect(cap.init?.method).toBe("DELETE");
  });
});

describe("verifyTotp", () => {
  const elevTable = () => fakeTable({ singles: [{ data: { id: "e1", expires_at: new Date(Date.now() + 900_000).toISOString() }, error: null }] });
  const auditTable = () => fakeTable();

  it("on success grants a totp elevation + audits — code/secret never persisted", async () => {
    const f = fakeFetch(200, { access_token: "x" });
    const elev = elevTable();
    const audit = auditTable();
    const { db, calls } = fakeDb({ system_elevations: elev, system_audit_events: audit });

    const res = await verifyTotp(db, user(), TOKEN, {
      factorId: "factor-1", challengeId: "ch-1", code: "123456",
    }, { config: CONFIG, fetchImpl: f as unknown as typeof fetch });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.elevatedUntil).toBeTruthy();
    // Only elevation + audit tables written — nothing else (two audit rows:
    // elevation.granted inside grantElevation + mfa.totp.verified here).
    expect([...new Set(calls)].sort()).toEqual(["system_audit_events", "system_elevations"]);
    const elevInsert = elev._insert as Record<string, unknown>;
    expect(elevInsert.method).toBe("totp");
    // The TOTP code and any secret material must not appear in ANY inserted row.
    const everything = JSON.stringify([elevInsert, audit._insert]);
    expect(everything).not.toContain("123456");
    expect(everything).not.toContain("secret");
    expect(everything).not.toContain("JBSW");
  });

  it("rejects bad input before calling GoTrue", async () => {
    const f = fakeFetch(200, {});
    const res = await verifyTotp(null, user(), TOKEN, { factorId: "", challengeId: "", code: "12" }, { config: CONFIG, fetchImpl: f as unknown as typeof fetch });
    expect(res.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("surfaces GoTrue verify failures without elevating", async () => {
    const f = fakeFetch(401, { msg: "invalid code" });
    const { db, calls } = fakeDb({});
    const res = await verifyTotp(db, user(), TOKEN, { factorId: "f1", challengeId: "c1", code: "000000" }, { config: CONFIG, fetchImpl: f as unknown as typeof fetch });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0); // no elevation/audit on failure
  });
});
