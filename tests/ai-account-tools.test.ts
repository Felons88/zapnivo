import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Account-scoped AI tools: every query must be bound to the SessionUser — the model can ask for
 * "reference ZR-XXX" but can never name another customer's id, email or phone.
 */

const { dbHolder } = vi.hoisted(() => ({ dbHolder: { db: null as unknown } }));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => dbHolder.db,
  anonClient: () => null,
  backendConfigured: () => true,
}));

import { runAssistant, type UserTurn } from "@/lib/ai/assistant";
import { agentAllowed } from "@/lib/ai/agent-gate";

const allowGate = async () => agentAllowed("test.agent");
import { runAccountTool } from "@/lib/ai/account-tools";
import type { ChatFn, ChatMessage } from "@/lib/ai/openrouter";
import type { SessionUser } from "@/lib/auth";
import { MemoryRepo } from "@/lib/helpdesk/memory-repo";
import { setRepoForTests } from "@/lib/helpdesk/repo";
import { resetRateLimits } from "@/lib/rate-limit";

type Row = Record<string, unknown>;

/* ── Minimal PostgREST-ish fake: filters rows in memory, awaitable builders. ── */

function matchCond(row: Row, cond: string): boolean {
  const m = cond.trim().match(/^([a-zA-Z_]+)\.(eq|neq)\.(.+)$/);
  if (!m) return false;
  const [, col, op, raw] = m;
  const val = raw === "null" ? null : raw;
  const cell = row[col];
  return op === "eq" ? cell === val : cell !== val;
}
function matchOr(row: Row, expr: string): boolean {
  return expr.split(",").some((part) => {
    const p = part.trim();
    if (p.startsWith("and(") && p.endsWith(")")) return p.slice(4, -1).split(",").every((c) => matchCond(row, c));
    return matchCond(row, p);
  });
}
const ilikeToRe = (pat: string) => new RegExp("^" + pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$", "i");

function fakeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const b: Record<string, unknown> = {};
      const self = () => b;
      b.select = self;
      b.eq = (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return b; };
      b.neq = (c: string, v: unknown) => { rows = rows.filter((r) => r[c] !== v); return b; };
      b.in = (c: string, vals: unknown[]) => { rows = rows.filter((r) => vals.includes(r[c])); return b; };
      b.or = (expr: string) => { rows = rows.filter((r) => matchOr(r, expr)); return b; };
      b.ilike = (c: string, pat: string) => { const re = ilikeToRe(pat); rows = rows.filter((r) => re.test(String(r[c] ?? ""))); return b; };
      b.gt = (c: string, v: unknown) => { rows = rows.filter((r) => r[c] != null && String(r[c]) > String(v)); return b; };
      b.is = (c: string, v: unknown) => { rows = rows.filter((r) => (v === null ? r[c] == null : r[c] === v)); return b; };
      b.order = (c: string, o?: { ascending?: boolean }) => {
        const asc = o?.ascending !== false;
        rows = [...rows].sort((a, b2) => (String(a[c]) < String(b2[c]) ? -1 : String(a[c]) > String(b2[c]) ? 1 : 0) * (asc ? 1 : -1));
        return b;
      };
      b.limit = (n: number) => { rows = rows.slice(0, n); return b; };
      b.insert = () => Promise.resolve({ data: null, error: null });
      b.update = () => b;
      b.delete = () => b;
      b.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
      b.single = async () => ({ data: rows[0] ?? null, error: rows[0] ? null : { message: "not found" } });
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res, rej);
      return b;
    },
  };
}

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const A: SessionUser = { id: "11111111-1111-1111-1111-111111111111", email: "amy@example.com", role: "customer", organizationId: null };
const B: SessionUser = { id: "22222222-2222-2222-2222-222222222222", email: "ben@example.com", role: "customer", organizationId: null };
const PARTNER: SessionUser = { id: "33333333-3333-3333-3333-333333333333", email: "owner@tavern.test", role: "partner", organizationId: "44444444-4444-4444-4444-444444444444" };

const pay = (over: Row = {}): Row => ({ state: "captured", amount_authorized_cents: 500, amount_captured_cents: 1299, amount_refunded_cents: 0, receipt_email: "amy@example.com", customer_phone: null, rental_id: "r-1", ...over });
const rental = (over: Row = {}): Row => ({
  id: "r-1", reference: "ZR-AAAA1111", state: "active", customer_id: A.id, renter_profile: null,
  started_at: "2026-11-08T18:00:00Z", dispensed_at: "2026-11-08T18:05:00Z", returned_at: null, created_at: "2026-11-08T18:00:00Z", non_return_deadline: null,
  kiosks: { station_id: "ZP-001", venues: { name: "Riverside Tavern", city: "St. Cloud" } },
  payments: [pay()],
  ...over,
});

const TABLES: Record<string, Row[]> = {
  profiles: [
    { id: A.id, email: A.email, phone: "+13205550111", full_name: "Amy Example" },
    { id: B.id, email: B.email, phone: null, full_name: "Ben Example" },
    { id: PARTNER.id, email: PARTNER.email, phone: null, full_name: "Olive Owner" },
  ],
  rentals: [
    rental(),
    rental({ id: "r-2", reference: "ZR-BBBB2222", state: "returned", customer_id: B.id, returned_at: "2026-11-07T20:00:00Z", payments: [pay({ rental_id: "r-2", receipt_email: "ben@example.com", amount_captured_cents: 999 })] }),
    rental({ id: "r-3", reference: "ZR-CCCC3333", state: "unreturned", customer_id: null, payments: [pay({ rental_id: "r-3", receipt_email: "amy@example.com", amount_captured_cents: 700 })] }),
  ],
  payments: [
    pay({ rental_id: "r-1" }),
    pay({ rental_id: "r-2", receipt_email: "ben@example.com", amount_captured_cents: 999 }),
    pay({ rental_id: "r-3", receipt_email: "amy@example.com", amount_captured_cents: 700 }),
  ],
  support_tickets: [
    { ticket_number: "Z-1001", email: "amy@example.com", phone: null, requester_type: "customer", organization_id: null, subject: "Charger stuck", category: "Other", state: "open", priority: "normal", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z" },
    { ticket_number: "Z-2002", email: "ben@example.com", phone: null, requester_type: "customer", organization_id: null, subject: "Ben ticket", category: "Other", state: "open", priority: "normal", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z" },
  ],
  organizations: [{ id: PARTNER.organizationId, name: "Tavern Group" }],
  venues: [{ name: "Riverside Tavern", city: "St. Cloud", state: "MN", venue_type: "Bar", published: true, organization_id: PARTNER.organizationId, kiosks: [{ state: "online", installed_at: "2026-01-01T00:00:00Z" }, { state: "offline", installed_at: "2026-01-01T00:00:00Z" }] }],
};

const U = (content: string): UserTurn => ({ role: "user", content });
const call = (name: string, args: object, id = "c1") => ({ content: null, tool_calls: [{ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const scripted = (...responses: Awaited<ReturnType<ChatFn>>[]) => {
  const seen: { messages: ChatMessage[]; tools?: unknown }[] = [];
  let i = 0;
  const chat: ChatFn = async (a) => { seen.push({ messages: structuredClone(a.messages), tools: a.tools }); return responses[Math.min(i++, responses.length - 1)]; };
  return { chat, seen };
};
const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  dbHolder.db = fakeDb(TABLES);
  setRepoForTests(new MemoryRepo());
});

describe("ownership scoping", () => {
  it("customer A sees only their own active rentals — not customer B's", async () => {
    const out = parse(await runAccountTool("get_my_active_rentals", dbHolder.db as never, A, {}));
    const refs = (out.rentals as { reference: string }[]).map((r) => r.reference);
    expect(refs).toContain("ZR-AAAA1111"); // account link
    expect(refs).toContain("ZR-CCCC3333"); // receipt email match
    expect(refs).not.toContain("ZR-BBBB2222"); // belongs to B
  });

  it("customer B cannot read A's rental details by reference (no existence leak)", async () => {
    const out = parse(await runAccountTool("get_my_rental_details", dbHolder.db as never, B, { reference: "ZR-AAAA1111" }));
    expect(out.error).toBe("not_found");
  });

  it("reference injection: A asking for B's reference returns not_found, and B's own reference works for B", async () => {
    const injected = parse(await runAccountTool("get_my_payment_status", dbHolder.db as never, A, { reference: "ZR-BBBB2222" }));
    expect(injected.error).toBe("not_found");
    const own = parse(await runAccountTool("get_my_payment_status", dbHolder.db as never, B, { reference: "ZR-BBBB2222" }));
    expect(own.reference).toBe("ZR-BBBB2222");
    expect(JSON.stringify(own)).not.toMatch(/pi_|stripe_payment_intent/i);
  });

  it("tickets list only the actor's own ticket numbers", async () => {
    const a = parse(await runAccountTool("get_my_support_tickets", dbHolder.db as never, A, {}));
    const b = parse(await runAccountTool("get_my_support_tickets", dbHolder.db as never, B, {}));
    expect((a.tickets as { number: string }[]).map((t) => t.number)).toEqual(["Z-1001"]);
    expect((b.tickets as { number: string }[]).map((t) => t.number)).toEqual(["Z-2002"]);
  });
});

describe("partner information", () => {
  it("rejects non-partner roles", async () => {
    const out = parse(await runAccountTool("get_my_partner_information", dbHolder.db as never, A, {}));
    expect(out.error).toBe("forbidden");
    const out2 = parse(await runAccountTool("get_my_partner_information", dbHolder.db as never, { ...PARTNER, role: "customer" }, {}));
    expect(out2.error).toBe("forbidden");
  });

  it("returns org name, venues and station counts for a partner — no financials", async () => {
    const out = parse(await runAccountTool("get_my_partner_information", dbHolder.db as never, PARTNER, {}));
    expect(out.organization).toBe("Tavern Group");
    expect((out.venues as { name: string }[])[0].name).toBe("Riverside Tavern");
    expect(out.stations).toMatchObject({ total: 2, online: 1 });
    expect(JSON.stringify(out)).not.toMatch(/revenue|payout|commission|rate/i);
  });
});

describe("runAssistant actor plumbing", () => {
  it("passes actor through: account tool executes and tools list includes account tools", async () => {
    const { chat, seen } = scripted(call("get_my_active_rentals", {}), { content: "You have one open rental." });
    const r = await runAssistant({ agentGate: allowGate, messages: [U("what rentals do I have?")], ip: "1.2.3.4", chat, actor: A });
    expect(r.reply).toBe("You have one open rental.");
    const toolMsg = seen[1].messages.find((m) => m.role === "tool");
    expect(toolMsg && JSON.stringify(toolMsg)).toContain("ZR-AAAA1111");
    const names = ((seen[0].tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names).toContain("get_my_active_rentals");
    expect(names).toContain("search_help_articles");
  });

  it("unauthenticated account-tool call returns authentication_required", async () => {
    const { chat, seen } = scripted(call("get_my_support_tickets", {}), { content: "Please verify first." });
    await runAssistant({ agentGate: allowGate, messages: [U("show my tickets")], ip: "1.2.3.4", chat });
    const toolMsg = seen[1].messages.find((m) => m.role === "tool");
    expect(toolMsg && JSON.stringify(toolMsg)).toContain("authentication_required");
    const names = ((seen[0].tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names).not.toContain("get_my_support_tickets");
  });

  it("adds the signed-in system note only when an actor is present", async () => {
    const { chat: c1, seen: s1 } = scripted({ content: "hi" });
    await runAssistant({ agentGate: allowGate, messages: [U("hi")], ip: "x", chat: c1, actor: A });
    const { chat: c2, seen: s2 } = scripted({ content: "hi" });
    await runAssistant({ agentGate: allowGate, messages: [U("hi")], ip: "x", chat: c2 });
    const sys1 = s1[0].messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
    const sys2 = s2[0].messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
    expect(sys1).toContain("signed in");
    expect(sys2).not.toContain("signed in");
  });
});
