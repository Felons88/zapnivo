import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ASSESSMENT_FIELDS, PLACEMENT_BOARD_STAGES, STAGE_LABELS,
  canTransition, daysInStage, followUpState, isFollowUpOverdue, isPlacementStage,
  legacyStatusForStage, legalMoves, loadPlacementBoard, moveStage,
  saveAssessment, shouldSyncStatus, updatePlacementMeta, validateAssessmentInput,
} from "@/lib/placement";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const APP_ID_2 = "22222222-2222-4222-8222-222222222222";
const STAFF_ID = "33333333-3333-4333-8333-333333333333";
const PARTNER_ID = "44444444-4444-4444-8444-444444444444";
const VENUE_ID = "55555555-5555-4555-8555-555555555555";

/* ── Stateful in-memory Supabase stub (same QB pattern as alert-emitters.test) ── */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const ensure = (t: string) => (tables[t] ??= []);
  let idc = 0;

  class QB {
    op: "select" | "insert" | "update" = "select";
    payload: unknown = null;
    filters: ((r: Row) => boolean)[] = [];
    orders: { c: string; asc: boolean }[] = [];
    lim: number | null = null;
    mode: "many" | "maybe" | "single" = "many";
    returning = false;
    constructor(public table: string) {}
    select(_cols?: string) { if (this.op === "insert") this.returning = true; return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === (v ?? null)); return this; }
    in(c: string, vals: unknown[]) { const s = new Set(vals); this.filters.push((r) => s.has(r[c])); return this; }
    order(c: string, o?: { ascending?: boolean }) { this.orders.push({ c, asc: o?.ascending !== false }); return this; }
    limit(n: number) { this.lim = n; return this; }
    maybeSingle() { this.mode = "maybe"; return this; }
    single() { this.mode = "single"; return this; }
    insert(p: unknown) { this.op = "insert"; this.payload = p; return this; }
    update(p: unknown) { this.op = "update"; this.payload = p; return this; }
    private matched() {
      let rows = ensure(this.table).filter((r) => this.filters.every((f) => f(r)));
      for (const o of [...this.orders].reverse()) {
        rows = [...rows].sort((a, b) => {
          const cmp = String(a[o.c] ?? "") < String(b[o.c] ?? "") ? -1 : String(a[o.c] ?? "") > String(b[o.c] ?? "") ? 1 : 0;
          return o.asc ? cmp : -cmp;
        });
      }
      if (this.lim != null) rows = rows.slice(0, this.lim);
      return rows;
    }
    private exec() {
      if (this.op === "insert") {
        const arr = Array.isArray(this.payload) ? this.payload : [this.payload];
        const ins = arr.map((r) => ({ ...(r as Row), id: (r as Row).id ?? `gen-${++idc}` }));
        ensure(this.table).push(...(ins as Row[]));
        return { data: this.returning ? (this.mode === "many" ? ins : ins[0] ?? null) : null, error: null };
      }
      if (this.op === "update") {
        for (const r of this.matched()) Object.assign(r, this.payload as Row);
        return { data: null, error: null };
      }
      const rows = this.matched();
      if (this.mode === "maybe") return { data: rows[0] ?? null, error: null };
      if (this.mode === "single") return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "not found" } };
      return { data: rows, error: null };
    }
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      return Promise.resolve().then(() => this.exec()).then(res, rej);
    }
  }
  return { from: (t: string) => new QB(t) as unknown as QB & PromiseLike<unknown>, tables, _QB: QB };
}
const asDb = (f: ReturnType<typeof fakeDb>) => ({ from: f.from }) as unknown as SupabaseClient;

const appRow = (over: Row = {}): Row => ({
  id: APP_ID, business_name: "Riverside Tavern", contact_name: "Sam Roe", email: "sam@example.com",
  phone: "555-0100", venue_type: "Bar / restaurant", street: "10 Main St", city: "St. Cloud",
  state: "MN", hours: null, guest_traffic: null, install_location: null, questions: null,
  product_interest: "snack,beverage", space_notes: null, timeline: null,
  status: "new", placement_stage: "inquiry", assigned_to: null, follow_up_at: null,
  next_action: null, created_at: "2026-06-01T00:00:00Z", ...over,
});

/* ── Stage transitions ─────────────────────────────────────────────────────── */

describe("canTransition / legalMoves", () => {
  it("allows forward and backward one step", () => {
    expect(canTransition("inquiry", "qualified")).toBe(true);
    expect(canTransition("qualified", "inquiry")).toBe(true);
    expect(canTransition("proposal", "negotiation")).toBe(true);
    expect(canTransition("negotiation", "proposal")).toBe(true);
  });

  it("rejects skipping forward or backward more than one step", () => {
    expect(canTransition("inquiry", "proposal")).toBe(false);
    expect(canTransition("proposal", "qualified")).toBe(false);
    expect(canTransition("installed", "sourcing")).toBe(false);
  });

  it("rejects no-op self moves", () => {
    for (const s of PLACEMENT_BOARD_STAGES) expect(canTransition(s, s)).toBe(false);
  });

  it("allows decline only from pre-approval stages", () => {
    expect(canTransition("inquiry", "declined")).toBe(true);
    expect(canTransition("negotiation", "declined")).toBe(true);
    expect(canTransition("approved", "declined")).toBe(false);
    expect(canTransition("sourcing", "declined")).toBe(false);
    expect(canTransition("installed", "declined")).toBe(false);
    expect(canTransition("active", "declined")).toBe(false);
  });

  it("reopens declined only to inquiry", () => {
    expect(canTransition("declined", "inquiry")).toBe(true);
    expect(canTransition("declined", "qualified")).toBe(false);
    expect(canTransition("declined", "proposal")).toBe(false);
  });

  it("treats active as terminal but installed can advance", () => {
    expect(canTransition("installed", "active")).toBe(true);
    expect(canTransition("active", "installed")).toBe(false);
    expect(canTransition("active", "declined")).toBe(false);
    expect(legalMoves("active")).toEqual([]);
    expect(legalMoves("declined")).toEqual(["inquiry"]);
    expect(legalMoves("inquiry")).toEqual(["qualified", "declined"]);
  });

  it("has a label for every board stage", () => {
    for (const s of PLACEMENT_BOARD_STAGES) expect(STAGE_LABELS[s]).toBeTruthy();
    expect(isPlacementStage("bogus")).toBe(false);
    expect(isPlacementStage("inquiry")).toBe(true);
  });
});

/* ── Legacy status sync ────────────────────────────────────────────────────── */

describe("legacyStatusForStage / shouldSyncStatus", () => {
  it("maps stages onto the application_state enum honestly", () => {
    expect(legacyStatusForStage("inquiry")).toBe("new");
    expect(legacyStatusForStage("site_survey")).toBe("reviewed");
    expect(legacyStatusForStage("proposal")).toBe("consultation");
    expect(legacyStatusForStage("agreement_pending")).toBe("consultation");
    expect(legacyStatusForStage("approved")).toBe("approved");
    expect(legacyStatusForStage("sourcing")).toBe("approved");
    expect(legacyStatusForStage("installed")).toBe("installed");
    expect(legacyStatusForStage("active")).toBe("installed");
    expect(legacyStatusForStage("declined")).toBe("declined");
  });

  it("never drags approved/installed backwards", () => {
    expect(shouldSyncStatus("approved", "reviewed")).toBe(false);
    expect(shouldSyncStatus("installed", "approved")).toBe(false);
    expect(shouldSyncStatus("approved", "consultation")).toBe(false);
  });

  it("allows forward and equal-rank status writes", () => {
    expect(shouldSyncStatus("new", "reviewed")).toBe(true);
    expect(shouldSyncStatus("approved", "installed")).toBe(true);
    expect(shouldSyncStatus("approved", "approved")).toBe(true);
    expect(shouldSyncStatus("consultation", "approved")).toBe(true);
  });

  it("always writes declined and lets a declined row reopen", () => {
    expect(shouldSyncStatus("reviewed", "declined")).toBe(true);
    expect(shouldSyncStatus("declined", "new")).toBe(true);
    expect(shouldSyncStatus("unknown_state", "reviewed")).toBe(true);
  });
});

/* ── Follow-up / stage-age helpers ─────────────────────────────────────────── */

describe("followUpState / isFollowUpOverdue / daysInStage", () => {
  const now = new Date(2026, 5, 15, 12, 0, 0); // local noon, Jun 15 2026

  it("classifies none/overdue/today/upcoming", () => {
    expect(followUpState(null, now)).toBe("none");
    expect(followUpState("not-a-date", now)).toBe("none");
    expect(followUpState(new Date(2026, 5, 14, 9, 0).toISOString(), now)).toBe("overdue");
    expect(followUpState(new Date(2026, 5, 15, 8, 0).toISOString(), now)).toBe("today");
    expect(followUpState(new Date(2026, 5, 16, 8, 0).toISOString(), now)).toBe("upcoming");
  });

  it("suppresses follow-ups on terminal stages", () => {
    const past = new Date(2026, 5, 1).toISOString();
    expect(isFollowUpOverdue(past, now, "active")).toBe(false);
    expect(isFollowUpOverdue(past, now, "declined")).toBe(false);
    expect(isFollowUpOverdue(past, now, "proposal")).toBe(true);
  });

  it("computes whole days in stage, clamped at zero", () => {
    expect(daysInStage(new Date(2026, 5, 10, 12, 0).toISOString(), now)).toBe(5);
    expect(daysInStage(new Date(2026, 5, 20).toISOString(), now)).toBe(0);
    expect(daysInStage(null, now)).toBe(0);
    expect(daysInStage("bogus", now)).toBe(0);
  });
});

/* ── Assessment validation ─────────────────────────────────────────────────── */

describe("validateAssessmentInput", () => {
  it("accepts a minimal payload and nulls empty fields", () => {
    const r = validateAssessmentInput({ application_id: APP_ID, traffic_estimate: "  200-1000 guests/day  " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.application_id).toBe(APP_ID);
      expect(r.value.traffic_estimate).toBe("200-1000 guests/day");
      expect(r.value.notes).toBeNull();
      expect(r.value.equipment_category).toBeNull();
    }
  });

  it("covers every assessment column", () => {
    const input: Record<string, string> = {};
    for (const f of ASSESSMENT_FIELDS) input[f] = `${f} value`;
    input.application_id = APP_ID;
    input.equipment_category = "snack"; // enum-restricted field
    const r = validateAssessmentInput(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      for (const f of ASSESSMENT_FIELDS) expect(r.value[f]).toBe(f === "equipment_category" ? "snack" : `${f} value`);
    }
  });

  it("rejects bad application ids and bad venue ids", () => {
    expect(validateAssessmentInput({ application_id: "nope" }).ok).toBe(false);
    expect(validateAssessmentInput({ application_id: APP_ID, venue_id: "nope" }).ok).toBe(false);
    expect(validateAssessmentInput(null).ok).toBe(false);
    expect(validateAssessmentInput("x").ok).toBe(false);
  });

  it("enforces short-text limits and string types", () => {
    expect(validateAssessmentInput({ application_id: APP_ID, notes: "x".repeat(1001) }).ok).toBe(false);
    expect(validateAssessmentInput({ application_id: APP_ID, notes: 42 }).ok).toBe(false);
    expect(validateAssessmentInput({ application_id: APP_ID, constraints: "x".repeat(1000) }).ok).toBe(true);
  });

  it("restricts equipment_category to known categories", () => {
    expect(validateAssessmentInput({ application_id: APP_ID, equipment_category: "snack" }).ok).toBe(true);
    expect(validateAssessmentInput({ application_id: APP_ID, equipment_category: "combo" }).ok).toBe(true);
    expect(validateAssessmentInput({ application_id: APP_ID, equipment_category: "hoverboard" }).ok).toBe(false);
  });
});

/* ── Mutations against the fake DB ─────────────────────────────────────────── */

describe("moveStage", () => {
  it("moves forward, syncs legacy status and writes a stage_change activity", async () => {
    const f = fakeDb({ partner_applications: [appRow()], placement_activities: [] });
    const res = await moveStage(asDb(f), STAFF_ID, APP_ID, "qualified", "called them");
    expect(res.ok).toBe(true);
    const app = f.tables.partner_applications[0];
    expect(app.placement_stage).toBe("qualified");
    expect(app.status).toBe("reviewed");
    expect(f.tables.placement_activities).toHaveLength(1);
    expect(f.tables.placement_activities[0].kind).toBe("stage_change");
    expect(String(f.tables.placement_activities[0].body)).toContain("Inquiry");
    expect(String(f.tables.placement_activities[0].body)).toContain("called them");
  });

  it("rejects illegal transitions without writing", async () => {
    const f = fakeDb({ partner_applications: [appRow()], placement_activities: [] });
    const res = await moveStage(asDb(f), STAFF_ID, APP_ID, "proposal");
    expect(res.ok).toBe(false);
    expect(f.tables.partner_applications[0].placement_stage).toBe("inquiry");
    expect(f.tables.placement_activities).toHaveLength(0);
  });

  it("returns not-found for unknown applications", async () => {
    const f = fakeDb({ partner_applications: [], placement_activities: [] });
    const res = await moveStage(asDb(f), STAFF_ID, APP_ID, "qualified");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not found/i);
  });

  it("decline clears follow_up_at and writes declined status", async () => {
    const f = fakeDb({ partner_applications: [appRow({ follow_up_at: "2026-06-20T00:00:00Z" })], placement_activities: [] });
    const res = await moveStage(asDb(f), STAFF_ID, APP_ID, "declined", "not a fit");
    expect(res.ok).toBe(true);
    expect(f.tables.partner_applications[0].placement_stage).toBe("declined");
    expect(f.tables.partner_applications[0].status).toBe("declined");
    expect(f.tables.partner_applications[0].follow_up_at).toBeNull();
  });

  it("does not regress legacy status when approved app steps back a stage", async () => {
    const f = fakeDb({ partner_applications: [appRow({ placement_stage: "sourcing", status: "approved" })], placement_activities: [] });
    const res = await moveStage(asDb(f), STAFF_ID, APP_ID, "approved");
    expect(res.ok).toBe(true);
    expect(f.tables.partner_applications[0].status).toBe("approved");
  });
});

describe("updatePlacementMeta", () => {
  const seed = () => fakeDb({
    partner_applications: [appRow()],
    profiles: [
      { id: STAFF_ID, role: "staff", email: "agent@x.com", full_name: "Agent" },
      { id: PARTNER_ID, role: "partner", email: "owner@x.com", full_name: null },
    ],
  });

  it("assigns a staff profile and saves meta", async () => {
    const f = seed();
    const res = await updatePlacementMeta(asDb(f), STAFF_ID, APP_ID, { assigned_to: STAFF_ID, next_action: "Send proposal", follow_up_at: "2026-06-20" });
    expect(res.ok).toBe(true);
    const app = f.tables.partner_applications[0];
    expect(app.assigned_to).toBe(STAFF_ID);
    expect(app.next_action).toBe("Send proposal");
    expect(app.follow_up_at).toBe("2026-06-20");
  });

  it("rejects non-staff assignees", async () => {
    const f = seed();
    const res = await updatePlacementMeta(asDb(f), STAFF_ID, APP_ID, { assigned_to: PARTNER_ID });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/staff/i);
    expect(f.tables.partner_applications[0].assigned_to).toBeNull();
  });

  it("rejects malformed ids, dates and over-long next actions", async () => {
    const f = seed();
    expect((await updatePlacementMeta(asDb(f), STAFF_ID, APP_ID, { assigned_to: "not-a-uuid" })).ok).toBe(false);
    expect((await updatePlacementMeta(asDb(f), STAFF_ID, APP_ID, { follow_up_at: "someday" })).ok).toBe(false);
    expect((await updatePlacementMeta(asDb(f), STAFF_ID, APP_ID, { next_action: "x".repeat(501) })).ok).toBe(false);
    expect((await updatePlacementMeta(asDb(f), STAFF_ID, APP_ID, {})).ok).toBe(false);
  });
});

describe("saveAssessment / loadAssessment", () => {
  it("inserts a new assessment with the actor stamped", async () => {
    const f = fakeDb({ partner_applications: [appRow()], venue_assessments: [] });
    const res = await saveAssessment(asDb(f), STAFF_ID, { application_id: APP_ID, venue_id: VENUE_ID, traffic_estimate: "busy", equipment_category: "snack" });
    expect(res.ok).toBe(true);
    expect(f.tables.venue_assessments).toHaveLength(1);
    expect(f.tables.venue_assessments[0].assessed_by).toBe(STAFF_ID);
    expect(f.tables.venue_assessments[0].application_id).toBe(APP_ID);
    // Informational only: pipeline untouched.
    expect(f.tables.partner_applications[0].placement_stage).toBe("inquiry");
  });

  it("updates the existing assessment instead of duplicating", async () => {
    const f = fakeDb({
      partner_applications: [appRow()],
      venue_assessments: [{ id: "a1", application_id: APP_ID, assessed_at: "2026-06-01T00:00:00Z", notes: "old" }],
    });
    const res = await saveAssessment(asDb(f), STAFF_ID, { application_id: APP_ID, notes: "new notes" });
    expect(res.ok).toBe(true);
    expect(res.id).toBe("a1");
    expect(f.tables.venue_assessments).toHaveLength(1);
    expect(f.tables.venue_assessments[0].notes).toBe("new notes");
    expect(f.tables.venue_assessments[0].assessed_by).toBe(STAFF_ID);
  });

  it("refuses assessments for unknown applications or invalid payloads", async () => {
    const f = fakeDb({ partner_applications: [appRow()], venue_assessments: [] });
    expect((await saveAssessment(asDb(f), STAFF_ID, { application_id: APP_ID_2 })).ok).toBe(false);
    expect((await saveAssessment(asDb(f), STAFF_ID, { application_id: "bad" })).ok).toBe(false);
    expect(f.tables.venue_assessments).toHaveLength(0);
  });
});

/* ── Board payload shape / org-safety ──────────────────────────────────────── */

describe("loadPlacementBoard", () => {
  const ALLOWED_KEYS = new Set([
    "id", "businessName", "contactName", "email", "phone", "venueType", "city", "state",
    "productInterest", "status", "stage", "assignedTo", "assigneeName", "followUpAt",
    "nextAction", "createdAt", "stageEnteredAt", "lastActivityAt", "hasAssessment",
    "daysInStage", "followUpOverdue",
  ]);

  it("returns one column per board stage, ordered, with grouped cards", async () => {
    const f = fakeDb({
      partner_applications: [appRow(), appRow({ id: APP_ID_2, placement_stage: "declined", status: "declined" })],
      placement_activities: [{ application_id: APP_ID, kind: "stage_change", created_at: "2026-06-10T00:00:00Z" }],
      venue_assessments: [{ application_id: APP_ID }],
      profiles: [{ id: STAFF_ID, full_name: "Agent Smith", email: "agent@x.com" }],
    });
    // assign second app to the staff member via a third row would need another app; keep simple:
    const board = await loadPlacementBoard(asDb(f), new Date(2026, 5, 15, 12, 0, 0));
    expect(board.map((c) => c.stage)).toEqual([...PLACEMENT_BOARD_STAGES]);
    const inquiry = board.find((c) => c.stage === "inquiry")!;
    const declined = board.find((c) => c.stage === "declined")!;
    expect(inquiry.cards).toHaveLength(1);
    expect(declined.cards).toHaveLength(1);
    expect(declined.cards[0].id).toBe(APP_ID_2);
    const card = inquiry.cards[0];
    expect(card.hasAssessment).toBe(true);
    expect(card.stageEnteredAt).toBe("2026-06-10T00:00:00Z"); // latest stage_change wins over created_at
    expect(card.daysInStage).toBe(5);
    expect(card.lastActivityAt).toBe("2026-06-10T00:00:00Z");
  });

  it("exposes only staff-safe business contact fields — no application internals", async () => {
    const f = fakeDb({ partner_applications: [appRow({ assigned_to: STAFF_ID, follow_up_at: "2026-06-01T00:00:00Z" })], placement_activities: [], venue_assessments: [], profiles: [{ id: STAFF_ID, full_name: null, email: "agent@x.com" }] });
    const board = await loadPlacementBoard(asDb(f), new Date(2026, 5, 15, 12, 0, 0));
    const card = board.flatMap((c) => c.cards)[0];
    for (const k of Object.keys(card)) expect(ALLOWED_KEYS.has(k)).toBe(true);
    // PII boundary: no street/hours/questions/space_notes/timeline internals on the board.
    const forbidden = ["street", "hours", "guest_traffic", "install_location", "questions", "space_notes", "timeline"];
    for (const k of forbidden) expect(k in card).toBe(false);
    expect(card.assigneeName).toBe("agent@x.com"); // falls back to email when no full_name
    expect(card.followUpOverdue).toBe(true);
  });

  it("handles an empty database gracefully", async () => {
    const f = fakeDb({});
    const board = await loadPlacementBoard(asDb(f));
    expect(board).toHaveLength(PLACEMENT_BOARD_STAGES.length);
    expect(board.every((c) => c.cards.length === 0)).toBe(true);
  });
});
