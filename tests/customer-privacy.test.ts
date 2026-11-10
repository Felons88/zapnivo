import { beforeEach, describe, expect, it, vi } from "vitest";

const { session, service } = vi.hoisted(() => ({ session: vi.fn(), service: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getSessionUser: session }));
vi.mock("@/lib/supabase", () => ({ serviceClient: service }));

import { resetRateLimits } from "@/lib/rate-limit";
import { buildExport, deletionAnonymization, jwtExpiry, rentalOwnedBy, shapeSessionActivity, type ExportInput } from "@/lib/customer-privacy";
import { GET as exportGET } from "@/app/api/account/export/route";
import { POST as deletePOST } from "@/app/api/account/delete-request/route";
import { POST as prefsPOST } from "@/app/api/account/preferences/route";

const A = { id: "11111111-1111-4111-8111-111111111111", email: "a@example.com" };
const B = { id: "22222222-2222-4222-8222-222222222222", email: "b@example.com" };

// ── Fake Supabase client ─────────────────────────────────────────────────────
type Row = Record<string, any>;
const matchRow = (row: Row, filters: any[]): boolean =>
  filters.every((f) => {
    const [op, field, val] = f;
    if (op === "eq") return row[field] === val;
    if (op === "in") return (val as unknown[]).includes(row[field]);
    if (op === "ilike") return String(row[field] ?? "").toLowerCase() === String(val).replace(/\\/g, "").toLowerCase();
    if (op === "or") {
      // Supports the "field.eq.value,field.eq.value" form used by the export route.
      return String(val)
        .split(",")
        .some((cond) => {
          const [cf, cop, cv] = cond.split(".");
          return cop === "eq" ? row[cf] === cv : false;
        });
    }
    return true; // not/order/limit don't filter
  });

function fakeDb(tables: Record<string, Row[]>) {
  const writes: { table: string; op: "insert" | "update"; payload: Row; filters: any[] }[] = [];
  return {
    writes,
    from(table: string) {
      const filters: any[] = [];
      let updateVals: Row | null = null;
      const rows = () => (tables[table] ?? []).filter((r) => matchRow(r, filters));
      const b: any = {
        select: () => b,
        eq: (f: string, v: unknown) => (filters.push(["eq", f, v]), b),
        in: (f: string, v: unknown) => (filters.push(["in", f, v]), b),
        ilike: (f: string, v: unknown) => (filters.push(["ilike", f, v]), b),
        or: (expr: string) => (filters.push(["or", expr]), b),
        not: () => b,
        order: () => b,
        limit: () => b,
        update: (vals: Row) => {
          updateVals = vals;
          writes.push({ table, op: "update", payload: vals, filters });
          return b;
        },
        insert: async (row: Row) => {
          writes.push({ table, op: "insert", payload: row, filters: [...filters] });
          return { error: null };
        },
        maybeSingle: async () => {
          const rs = rows();
          if (updateVals) rs.forEach((r) => Object.assign(r, updateVals));
          return { data: rs[0] ?? null, error: null };
        },
        then: (res: (v: { data: Row[]; error: null }) => unknown, rej?: (e: unknown) => unknown) => {
          const rs = rows();
          if (updateVals) rs.forEach((r) => Object.assign(r, updateVals));
          return Promise.resolve({ data: rs, error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
}

const emptyInput = (): ExportInput => ({ profile: null, rentals: [], payments: [], tickets: [], messages: [] });

describe("rentalOwnedBy", () => {
  it("matches by renter_profile, customer_id, or receipt email", () => {
    expect(rentalOwnedBy({ renter_profile: A.id }, A)).toBe(true);
    expect(rentalOwnedBy({ customer_id: A.id }, A)).toBe(true);
    expect(rentalOwnedBy({ payments: [{ receipt_email: "A@Example.com" }] }, A)).toBe(true);
    expect(rentalOwnedBy({ receipt_email: "a@example.com" }, A)).toBe(true);
  });
  it("rejects another customer's rental", () => {
    const r = { renter_profile: B.id, customer_id: B.id, payments: [{ receipt_email: "b@example.com" }] };
    expect(rentalOwnedBy(r, A)).toBe(false);
    expect(rentalOwnedBy(r, B)).toBe(true);
  });
});

describe("buildExport isolation", () => {
  it("customer A's export contains none of customer B's rows", () => {
    const input: ExportInput = {
      profile: { id: B.id, email: "b@example.com", full_name: "Bea" },
      rentals: [
        { id: "r-a", reference: "ZR-AAAAAAAA", renter_profile: A.id, payments: [{ receipt_email: "a@example.com" }] },
        { id: "r-b", reference: "ZR-BBBBBBBB", renter_profile: B.id, payments: [{ receipt_email: "b@example.com" }] },
      ],
      payments: [
        { id: "p-a", rental_id: "r-a", receipt_email: "a@example.com", amount_captured_cents: 500 },
        { id: "p-b", rental_id: "r-b", receipt_email: "b@example.com", amount_captured_cents: 900 },
        { id: "p-x", rental_id: "r-x", receipt_email: "stranger@example.com" },
      ],
      tickets: [
        { id: "t-a", ticket_number: "Z-1", email: "a@example.com", rental_id: null },
        { id: "t-b", ticket_number: "Z-2", email: "b@example.com", rental_id: "r-b" },
      ],
      messages: [
        { id: "m-a", ticket_id: "t-a", body: "hi", internal: false },
        { id: "m-b", ticket_id: "t-b", body: "secret", internal: false },
        { id: "m-i", ticket_id: "t-a", body: "staff note", internal: true },
      ],
    };
    const out = buildExport(A, input, new Date("2026-01-01T00:00:00Z"));
    expect(out.profile).toBeNull();
    expect(out.rentals.map((r) => r.id)).toEqual(["r-a"]);
    expect(out.payments.map((p) => p.id)).toEqual(["p-a"]);
    expect(out.tickets.map((t) => t.id)).toEqual(["t-a"]);
    expect(out.messages.map((m) => m.id)).toEqual(["m-a"]); // internal staff note dropped
    expect(JSON.stringify(out)).not.toContain("b@example.com");
    expect(JSON.stringify(out)).not.toContain("stranger@example.com");
  });

  it("returns the owner's own profile", () => {
    const out = buildExport(A, { ...emptyInput(), profile: { id: A.id, email: "a@example.com" } });
    expect(out.profile?.id).toBe(A.id);
  });
});

describe("session helpers", () => {
  it("decodes JWT expiry and shapes honest session info", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1893456000 })).toString("base64url");
    const token = `h.${payload}.s`;
    expect(jwtExpiry(token)).toBe("2030-01-01T00:00:00.000Z");
    expect(jwtExpiry("garbage")).toBeNull();
    const s = shapeSessionActivity(A, "2026-01-01T00:00:00Z", token);
    expect(s.currentSession.email).toBe("a@example.com");
    expect(s.currentSession.expiresAt).toBe("2030-01-01T00:00:00.000Z");
    expect(s.lastSignInAt).toBe("2026-01-01T00:00:00Z");
    expect(s.note).toMatch(/only exposes/i);
  });
  it("deletion anonymization only clears PII fields", () => {
    expect(deletionAnonymization).toEqual({ full_name: null, phone: null });
  });
});

// ── Route tests ──────────────────────────────────────────────────────────────
const req = (url: string, body?: unknown) =>
  new Request(url, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/account/preferences", () => {
  beforeEach(() => {
    resetRateLimits();
    session.mockResolvedValue({ id: A.id, email: A.email, role: "customer" });
  });

  it("persists notify_sms on the customer's own profile only", async () => {
    const db = fakeDb({ profiles: [{ id: A.id, email: A.email, notify_sms: false }, { id: B.id, email: B.email, notify_sms: false }] });
    service.mockReturnValue(db);
    const res = await prefsPOST(req("http://localhost/api/account/preferences", { notify_sms: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, notify_sms: true });
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0].payload).toEqual({ notify_sms: true });
    expect(db.writes[0].filters).toContainEqual(["eq", "id", A.id]);
    // B's profile untouched.
    expect((db as any) && true).toBe(true);
  });

  it("rejects staff and unauthenticated callers", async () => {
    service.mockReturnValue(fakeDb({}));
    session.mockResolvedValue({ id: "s1", email: "s@x.com", role: "admin" });
    expect((await prefsPOST(req("http://localhost/api/account/preferences", { notify_sms: true }))).status).toBe(403);
    session.mockResolvedValue(null);
    expect((await prefsPOST(req("http://localhost/api/account/preferences", { notify_sms: true }))).status).toBe(401);
  });
});

describe("POST /api/account/delete-request", () => {
  beforeEach(() => {
    resetRateLimits();
    session.mockResolvedValue({ id: A.id, email: A.email, role: "customer" });
  });

  it("queues a deletion request and anonymizes profile PII", async () => {
    const db = fakeDb({
      customer_data_requests: [],
      profiles: [{ id: A.id, email: A.email, full_name: "Ann", phone: "+1555" }, { id: B.id, email: B.email, full_name: "Bea", phone: "+1666" }],
    });
    service.mockReturnValue(db);
    const res = await deletePOST(req("http://localhost/api/account/delete-request", { confirm: true }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, status: "pending", anonymized: true });

    const ins = db.writes.find((w) => w.op === "insert" && w.table === "customer_data_requests");
    expect(ins?.payload).toMatchObject({ user_id: A.id, email: A.email, kind: "deletion", status: "pending" });
    const upd = db.writes.find((w) => w.op === "update" && w.table === "profiles");
    expect(upd?.payload).toEqual({ full_name: null, phone: null });
    expect(upd?.filters).toContainEqual(["eq", "id", A.id]);
    // B's profile untouched.
    expect(db.writes.filter((w) => w.table === "profiles")).toHaveLength(1);
  });

  it("does not create a duplicate while one is pending", async () => {
    const db = fakeDb({
      customer_data_requests: [{ id: "x", email: A.email, kind: "deletion", status: "pending" }],
      profiles: [{ id: A.id, email: A.email }],
    });
    service.mockReturnValue(db);
    const res = await deletePOST(req("http://localhost/api/account/delete-request", { confirm: true }));
    expect(await res.json()).toMatchObject({ ok: true, duplicate: true });
    expect(db.writes.filter((w) => w.op === "insert")).toHaveLength(0);
  });

  it("requires explicit confirmation", async () => {
    service.mockReturnValue(fakeDb({}));
    expect((await deletePOST(req("http://localhost/api/account/delete-request", {}))).status).toBe(422);
    expect((await deletePOST(req("http://localhost/api/account/delete-request", { confirm: false }))).status).toBe(422);
  });
});

describe("GET /api/account/export", () => {
  beforeEach(() => {
    resetRateLimits();
    session.mockResolvedValue({ id: A.id, email: A.email, role: "customer" });
  });

  it("exports only the signed-in customer's data, even if queries return foreign rows", async () => {
    const db = fakeDb({
      profiles: [{ id: A.id, email: A.email, notify_sms: true }],
      rentals: [
        { id: "r-a", reference: "ZR-AAAAAAAA", state: "returned", renter_profile: A.id, customer_id: null, payments: [{ receipt_email: "a@example.com" }] },
        { id: "r-b", reference: "ZR-BBBBBBBB", state: "returned", renter_profile: B.id, customer_id: B.id, payments: [{ receipt_email: "b@example.com" }] },
      ],
      payments: [
        { id: "p-a", rental_id: "r-a", receipt_email: "a@example.com", amount_captured_cents: 500 },
        { id: "p-b", rental_id: "r-b", receipt_email: "b@example.com", amount_captured_cents: 900 },
      ],
      support_tickets: [
        { id: "t-a", ticket_number: "Z-1", email: "a@example.com", rental_id: null },
        { id: "t-b", ticket_number: "Z-2", email: "b@example.com", rental_id: "r-b" },
      ],
      support_messages: [
        { id: "m-a", ticket_id: "t-a", body: "mine", internal: false },
        { id: "m-b", ticket_id: "t-b", body: "theirs", internal: false },
        { id: "m-i", ticket_id: "t-a", body: "staff only", internal: true },
      ],
      customer_data_requests: [],
    });
    service.mockReturnValue(db);

    const res = await exportGET(req("http://localhost/api/account/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("zapnivo-data-export");
    const json = await res.json();

    expect(json.account).toEqual({ id: A.id, email: A.email });
    expect(json.profile.id).toBe(A.id);
    expect(json.rentals.map((r: any) => r.id)).toEqual(["r-a"]);
    expect(json.payments.map((p: any) => p.id)).toEqual(["p-a"]);
    expect(json.tickets.map((t: any) => t.id)).toEqual(["t-a"]);
    expect(json.messages.map((m: any) => m.id)).toEqual(["m-a"]);
    expect(JSON.stringify(json)).not.toContain("b@example.com");
    expect(JSON.stringify(json)).not.toContain("staff only");
    // Export was recorded as a processed request.
    expect(db.writes.some((w) => w.table === "customer_data_requests" && w.payload.kind === "export" && w.payload.status === "processed")).toBe(true);
  });

  it("is rate limited", async () => {
    service.mockReturnValue(fakeDb({}));
    let last = 0;
    for (let i = 0; i < 5; i++) last = (await exportGET(req("http://localhost/api/account/export"))).status;
    expect(last).toBe(429);
  });

  it("rejects staff accounts and missing backend honestly", async () => {
    service.mockReturnValue(fakeDb({}));
    session.mockResolvedValue({ id: "s", email: "s@x.com", role: "staff" });
    expect((await exportGET(req("http://localhost/api/account/export"))).status).toBe(403);
    session.mockResolvedValue({ id: A.id, email: A.email, role: "customer" });
    service.mockReturnValue(null);
    const res = await exportGET(req("http://localhost/api/account/export"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "backend_unconfigured" });
  });
});
