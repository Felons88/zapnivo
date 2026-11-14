import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assignIncident, addIncidentNote, linkIncidentEvidence, getIncidentTimeline,
  listAssignableUsers, transitionIncident, parseIncidentLinks,
  type IncidentRow,
} from "@/lib/system/incidents";

/* ── Stateful in-memory Supabase stub (same QB pattern as alert-sweep-phase4) ── */

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
    private lim: number | null = null;
    constructor(private name: string) {}
    select() { return this; }
    insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
    update(p: unknown) { this.op = "update"; this.payload = p; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => eqv(r[c], v)); return this; }
    is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
    not(c: string, op: string, v: unknown) { if (op === "is") this.filters.push((r) => (r[c] ?? null) !== v); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    neq(c: string, v: unknown) { this.filters.push((r) => !eqv(r[c], v)); return this; }
    gt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) > 0); return this; }
    gte(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) >= 0); return this; }
    lt(c: string, v: unknown) { this.filters.push((r) => cmp(r[c], v) < 0); return this; }
    order() { return this; }
    limit(n: number) { this.lim = n; return this; }

    private run() {
      const rows = ensure(this.name);
      const match = (r: Row) => this.filters.every((f) => f(r));
      if (this.op === "insert") {
        const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        for (const item of items) rows.push({ created_at: new Date().toISOString(), ...item });
        return { data: items, error: null };
      }
      if (this.op === "update") {
        const affected = rows.filter(match);
        for (const r of affected) Object.assign(r, this.payload as Row);
        return { data: affected, error: null };
      }
      let out = rows.filter(match);
      if (this.lim != null) out = out.slice(0, this.lim);
      return { data: out, error: null };
    }
    single() {
      const { data } = this.run();
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      if (rows.length === 0) return Promise.resolve({ data: null, error: { code: "PGRST116", message: "0 rows" } });
      return Promise.resolve({ data: rows[0], error: null });
    }
    maybeSingle() {
      const { data } = this.run();
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    }
    then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.run()).then(onF, onR);
    }
  }

  return { from: (t: string) => new QB(t), _tables: tables } as unknown as SupabaseClient & { _tables: Record<string, Row[]> };
}

const actor = { id: "11111111-1111-4111-8111-111111111111", role: "sysadmin" };
const INCIDENT_ID = "22222222-2222-4222-8222-222222222222";

function incidentRow(over: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: INCIDENT_ID, number: "INC-0001", title: "Test incident", severity: "sev3",
    status: "investigating", source: "manual", services: [], owner: null, summary: null,
    resolution_notes: null, links: [],
    detected_at: "2026-02-01T10:00:00Z", acknowledged_at: null, resolved_at: null,
    created_at: "2026-02-01T10:00:00Z",
    ...over,
  };
}

describe("assignIncident", () => {
  it("assigns a system user, audits, and updates owner", async () => {
    const db = fakeDb({
      incidents: [incidentRow()],
      profiles: [{ id: "33333333-3333-4333-8333-333333333333", system_role: "engineer", system_suspended: false }],
      system_audit_events: [],
    });
    const res = await assignIncident(db, actor, INCIDENT_ID, "33333333-3333-4333-8333-333333333333");
    expect(res.ok).toBe(true);
    const row = db._tables.incidents[0];
    expect(row.owner).toBe("33333333-3333-4333-8333-333333333333");
    const audit = db._tables.system_audit_events.at(-1)!;
    expect(audit.action).toBe("incident.assigned");
  });

  it("rejects non-system users and suspended assignees", async () => {
    const noRole = fakeDb({
      incidents: [incidentRow()],
      profiles: [{ id: "33333333-3333-4333-8333-333333333333", system_role: null }],
    });
    const r1 = await assignIncident(noRole, actor, INCIDENT_ID, "33333333-3333-4333-8333-333333333333");
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.status).toBe(422);

    const suspended = fakeDb({
      incidents: [incidentRow()],
      profiles: [{ id: "33333333-3333-4333-8333-333333333333", system_role: "viewer", system_suspended: true }],
    });
    const r2 = await assignIncident(suspended, actor, INCIDENT_ID, "33333333-3333-4333-8333-333333333333");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe("assignee_suspended");
  });

  it("unassigns with null and is idempotent", async () => {
    const db = fakeDb({
      incidents: [incidentRow({ owner: "33333333-3333-4333-8333-333333333333" })],
      system_audit_events: [],
    });
    const res = await assignIncident(db, actor, INCIDENT_ID, null);
    expect(res.ok).toBe(true);
    expect(db._tables.incidents[0].owner).toBeNull();
    expect(db._tables.system_audit_events.at(-1)!.action).toBe("incident.unassigned");
    // second unassign → no-op, no extra audit row
    const before = db._tables.system_audit_events.length;
    const again = await assignIncident(db, actor, INCIDENT_ID, null);
    expect(again.ok).toBe(true);
    expect(db._tables.system_audit_events.length).toBe(before);
  });

  it("404s on unknown incident", async () => {
    const db = fakeDb({ incidents: [] });
    const res = await assignIncident(db, actor, INCIDENT_ID, null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });
});

describe("addIncidentNote", () => {
  it("writes an audited incident.note event", async () => {
    const db = fakeDb({ incidents: [incidentRow()], system_audit_events: [] });
    const res = await addIncidentNote(db, actor, INCIDENT_ID, "Root cause: stale device clock.");
    expect(res.ok).toBe(true);
    const audit = db._tables.system_audit_events.at(-1)!;
    expect(audit.action).toBe("incident.note");
    expect((audit.detail as Row).note).toContain("stale device clock");
  });

  it("rejects short notes", async () => {
    const db = fakeDb({ incidents: [incidentRow()] });
    const res = await addIncidentNote(db, actor, INCIDENT_ID, "no");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(422);
  });
});

describe("linkIncidentEvidence", () => {
  it("merges links, dedupes on type+id, and audits", async () => {
    const db = fakeDb({
      incidents: [incidentRow({ links: [{ type: "error_issue", id: "fp-1" }] })],
      system_audit_events: [],
    });
    const res = await linkIncidentEvidence(db, actor, INCIDENT_ID, [
      { type: "error_issue", id: "fp-1" },          // duplicate — skipped
      { type: "device", id: "dev-9", label: "kiosk-07" },
      { type: "bogus", id: "x" },                    // invalid — filtered
    ]);
    expect(res.ok).toBe(true);
    const links = db._tables.incidents[0].links as Row[];
    expect(links).toHaveLength(2);
    expect(links[1]).toMatchObject({ type: "device", id: "dev-9", label: "kiosk-07" });
    expect(db._tables.system_audit_events.at(-1)!.action).toBe("incident.evidence_linked");
  });

  it("rejects empty/invalid link payloads", async () => {
    const db = fakeDb({ incidents: [incidentRow()] });
    const empty = await linkIncidentEvidence(db, actor, INCIDENT_ID, []);
    expect(empty.ok).toBe(false);
    const bad = await linkIncidentEvidence(db, actor, INCIDENT_ID, [{ type: "nope", id: "x" }]);
    expect(bad.ok).toBe(false);
  });
});

describe("transitionIncident — resolution notes", () => {
  it("requires resolution notes to resolve (422 without)", async () => {
    const db = fakeDb({ incidents: [incidentRow({ status: "monitoring" })] });
    const res = await transitionIncident(db, actor, INCIDENT_ID, "resolved");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(422);
      expect(res.error).toBe("resolution_notes_required");
    }
    expect(db._tables.incidents[0].status).toBe("monitoring"); // unchanged
  });

  it("stores resolution_notes on resolve and clears them on reopen", async () => {
    const db = fakeDb({
      incidents: [incidentRow({ status: "monitoring" })],
      system_incident_events: [],
      system_audit_events: [],
    });
    const res = await transitionIncident(db, actor, INCIDENT_ID, "resolved", undefined, "Patched gateway firmware.");
    expect(res.ok).toBe(true);
    expect(db._tables.incidents[0].status).toBe("resolved");
    expect(db._tables.incidents[0].resolution_notes).toBe("Patched gateway firmware.");
    expect(typeof db._tables.incidents[0].resolved_at).toBe("string");

    const reopen = await transitionIncident(db, actor, INCIDENT_ID, "reopened", "regression in prod");
    expect(reopen.ok).toBe(true);
    expect(db._tables.incidents[0].resolution_notes).toBeNull();
    expect(db._tables.incidents[0].resolved_at).toBeNull();
  });
});

describe("getIncidentTimeline", () => {
  it("merges transition events and incident.* audit rows, newest first", async () => {
    const db = fakeDb({
      incidents: [incidentRow()],
      system_incident_events: [
        { id: "e1", incident_id: INCIDENT_ID, from_status: "detected", to_status: "investigating", actor_id: actor.id, reason: null, created_at: "2026-02-01T10:01:00Z" },
      ],
      system_audit_events: [
        { id: "a1", action: "incident.note", actor_id: actor.id, actor_role: "sysadmin", resource: `incident:${INCIDENT_ID}`, detail: { note: "looking" }, created_at: "2026-02-01T10:02:00Z" },
        { id: "a2", action: "unrelated.action", actor_id: actor.id, actor_role: "sysadmin", resource: `incident:${INCIDENT_ID}`, detail: {}, created_at: "2026-02-01T10:03:00Z" },
        { id: "a3", action: "incident.assigned", actor_id: actor.id, actor_role: "sysadmin", resource: "other:resource", detail: {}, created_at: "2026-02-01T10:04:00Z" },
      ],
    });
    const { timeline } = await getIncidentTimeline(db, INCIDENT_ID);
    expect(timeline).toHaveLength(2); // transition + note; unrelated.action filtered, other resource excluded
    expect(timeline[0].kind).toBe("audit");
    expect(timeline[0].at > timeline[1].at).toBe(true);
  });
});

describe("listAssignableUsers / parseIncidentLinks", () => {
  it("lists only non-suspended system users", async () => {
    const db = fakeDb({
      profiles: [
        { id: "u1", email: "a@x.com", full_name: "A", system_role: "engineer", system_suspended: false },
        { id: "u2", email: "b@x.com", full_name: "B", system_role: "viewer", system_suspended: true },
        { id: "u3", email: "c@x.com", full_name: "C", system_role: null, system_suspended: false },
      ],
    });
    const { users } = await listAssignableUsers(db);
    expect(users.map((u) => u.id)).toEqual(["u1"]);
  });

  it("parseIncidentLinks validates and caps", () => {
    expect(parseIncidentLinks(null)).toEqual([]);
    expect(parseIncidentLinks([{ type: "device", id: "d1" }, { type: "bad", id: "x" }, "junk"])).toEqual([{ type: "device", id: "d1" }]);
  });
});
