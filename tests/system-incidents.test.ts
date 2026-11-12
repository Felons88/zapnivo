import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  INCIDENT_TRANSITIONS, INCIDENT_STATUSES, isIncidentStatus,
  listIncidentEvents, transitionIncident, transitionSchema,
  type IncidentRow,
} from "@/lib/system/incidents";

/* ── Minimal Supabase stub ─────────────────────────────────────────────── */

type Result = { data?: unknown; error?: { message: string } | null; count?: number | null };
function fakeTable(opts: { list?: Result; singles?: Result[] } = {}) {
  const singles = [...(opts.singles ?? [])];
  const b: Record<string, unknown> & { _insert?: unknown; _update?: unknown } = {};
  const next = (): Result => singles.length ? singles.shift()! : { data: null, error: null };
  for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "insert", "update", "upsert", "delete", "filter"]) {
    b[m] = (...a: unknown[]) => {
      if (m === "insert") b._insert = a[0];
      if (m === "update") b._update = a[0];
      return b;
    };
  }
  b.single = async () => next();
  b.maybeSingle = async () => next();
  b.then = (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(opts.list ?? { data: [], error: null, count: 0 }).then(res, rej);
  return b;
}
function fakeDb(tables: Record<string, ReturnType<typeof fakeTable>>) {
  return { from: (t: string) => tables[t] ?? fakeTable() } as unknown as SupabaseClient;
}

const actor = { id: "actor-1", role: "sysadmin" };

function incident(over: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    number: "INC-0001",
    title: "Test incident",
    severity: "sev3",
    status: "detected",
    source: "manual",
    services: [],
    summary: null,
    detected_at: "2026-02-01T10:00:00Z",
    acknowledged_at: null,
    resolved_at: null,
    created_at: "2026-02-01T10:00:00Z",
    ...over,
  };
}

/** incidents table serves: [0] maybeSingle fetch, [1] update().select().single() */
function incidentsDb(row: IncidentRow, updated?: IncidentRow) {
  return fakeTable({ singles: [{ data: row, error: null }, { data: updated ?? { ...row }, error: null }] });
}

describe("INCIDENT_TRANSITIONS", () => {
  it("covers every declared status", () => {
    for (const s of INCIDENT_STATUSES) expect(INCIDENT_TRANSITIONS[s]).toBeDefined();
    expect(isIncidentStatus("reopened")).toBe(true);
    expect(isIncidentStatus("bogus")).toBe(false);
  });

  it("resolved incidents can only reopen (reason required), never jump backwards", () => {
    expect(INCIDENT_TRANSITIONS.resolved).toEqual(["reopened"]);
    expect(INCIDENT_TRANSITIONS.monitoring).toContain("reopened");
    expect(INCIDENT_TRANSITIONS.detected).not.toContain("reopened");
  });
});

describe("transitionIncident", () => {
  it("executes a legal transition and writes history + audit", async () => {
    const row = incident({ status: "detected" });
    const events = fakeTable({ singles: [{ data: { id: "ev-1", incident_id: row.id, from_status: "detected", to_status: "investigating", actor_id: "actor-1", reason: "triage started", created_at: "2026-02-01T10:05:00Z" }, error: null }] });
    const audit = fakeTable();
    const db = fakeDb({ incidents: incidentsDb(row, { ...row, status: "investigating" }), system_incident_events: events, system_audit_events: audit });

    const res = await transitionIncident(db, actor, row.id, "investigating", "triage started");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.incident.status).toBe("investigating");
    expect(res.event?.to_status).toBe("investigating");

    const ev = events._insert as Record<string, unknown>;
    expect(ev.incident_id).toBe(row.id);
    expect(ev.from_status).toBe("detected");
    expect(ev.to_status).toBe("investigating");
    expect(ev.actor_id).toBe("actor-1");
    expect(ev.reason).toBe("triage started");

    const au = audit._insert as Record<string, unknown>;
    expect(au.action).toBe("incident.transitioned");
    // systemAudit scrub() redacts uuid-shaped strings in resource — assert prefix only.
    expect(String(au.resource)).toMatch(/^incident:/);
  });

  it("rejects illegal transitions with 409 + allowed targets", async () => {
    const row = incident({ status: "resolved", resolved_at: "2026-02-01T11:00:00Z" });
    const db = fakeDb({ incidents: incidentsDb(row) });
    const res = await transitionIncident(db, actor, row.id, "mitigating");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.allowed).toEqual(["reopened"]);
  });

  it("rejects same-status transitions", async () => {
    const row = incident({ status: "investigating" });
    const db = fakeDb({ incidents: incidentsDb(row) });
    const res = await transitionIncident(db, actor, row.id, "investigating");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });

  it("requires a reason to reopen a resolved incident", async () => {
    const row = incident({ status: "resolved", resolved_at: "2026-02-01T11:00:00Z" });
    // maybeSingle always returns the resolved row; single returns the post-update row.
    const incidents = fakeTable();
    incidents.maybeSingle = async () => ({ data: row, error: null });
    incidents.single = async () => ({ data: { ...row, status: "reopened", resolved_at: null }, error: null });
    const db = fakeDb({ incidents });
    const noReason = await transitionIncident(db, actor, row.id, "reopened");
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.status).toBe(422);

    const shortReason = await transitionIncident(db, actor, row.id, "reopened", "no");
    expect(shortReason.ok).toBe(false);

    const ok = await transitionIncident(db, actor, row.id, "reopened", "regression observed in prod");
    expect(ok.ok).toBe(true);
    const patch = incidents._update as Record<string, unknown>;
    expect(patch.status).toBe("reopened");
    expect(patch.resolved_at).toBeNull();
  });

  it("sets resolved_at when transitioning to resolved", async () => {
    const row = incident({ status: "monitoring" });
    const incidents = incidentsDb(row);
    const db = fakeDb({ incidents });
    const res = await transitionIncident(db, actor, row.id, "resolved", "fix verified");
    expect(res.ok).toBe(true);
    const patch = incidents._update as Record<string, unknown>;
    expect(patch.status).toBe("resolved");
    expect(typeof patch.resolved_at).toBe("string");
  });

  it("returns 404 for unknown incidents", async () => {
    const db = fakeDb({ incidents: fakeTable({ singles: [{ data: null, error: null }] }) });
    const res = await transitionIncident(db, actor, "22222222-2222-4222-8222-222222222222", "investigating");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });

  it("breakglass actors get a pending change request, not an execution", async () => {
    const row = incident({ status: "detected" });
    const cr = fakeTable({ singles: [{ data: { id: "cr-1" }, error: null }] });
    const audit = fakeTable();
    const incidents = incidentsDb(row);
    const db = fakeDb({ incidents, system_change_requests: cr, system_audit_events: audit });
    const res = await transitionIncident(db, { id: "bg-1", role: "breakglass" }, row.id, "investigating");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(202);
      expect(res.reason).toContain("approval");
    }
    // no status update was applied
    expect(incidents._update).toBeUndefined();
  });
});

describe("listIncidentEvents", () => {
  it("returns rows for an incident", async () => {
    const events = fakeTable({
      list: { data: [{ id: "e1", incident_id: "i1", from_status: "detected", to_status: "investigating", actor_id: "a", reason: null, created_at: "2026-02-01T10:01:00Z" }], error: null },
    });
    const db = fakeDb({ system_incident_events: events });
    const rows = await listIncidentEvents(db, "i1");
    expect(rows).toHaveLength(1);
    expect(rows[0].to_status).toBe("investigating");
  });
});

describe("transitionSchema", () => {
  it("validates to_status against known statuses", () => {
    expect(transitionSchema.safeParse({ to_status: "resolved" }).success).toBe(true);
    expect(transitionSchema.safeParse({ to_status: "reopened", reason: "why" }).success).toBe(true);
    expect(transitionSchema.safeParse({ to_status: "bogus" }).success).toBe(false);
  });
});
