import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { scrub } from "@/lib/observability";
import { sanitizeAuditDetail, assertApprovedOrRequest, systemAudit, type SystemActor } from "./audit";

/**
 * Rental exception management (system.kiosks exceptions console, Phase 2.6).
 *
 * Source: `rental_exceptions` (migration 0050, extended by 0054). Rows are
 * raised by the kiosk ack/reconciliation layer (src/lib/kiosk/lifecycle.ts,
 * commands.ts) when a device acknowledgement cannot be honestly reconciled —
 * never auto-settled. This module owns the staff workflow on top:
 * list / detail+evidence / assign / note / lifecycle transition.
 *
 * State machine (canonical; 'open' is the legacy 0050 value mapped to 'new',
 * 'dismissed' is a legacy terminal state with no outgoing edges):
 *
 *   new → investigating → awaiting_device | awaiting_support |
 *         requires_financial_review → resolved → reopened (reason required)
 *
 * Financial honesty: `requires_financial_review` and financial kinds
 * (bank_mismatch, rental_ref_mismatch, …) are INFORMATIONAL. Resolving an
 * exception only closes this investigation record — it never moves money;
 * money decisions stay in fin_cases (0039). The financial_review flag is
 * preserved on the row and re-stated in the audit event on resolve.
 *
 * Permissions mirror incidents.ts: reads need system.kiosks.view; mutations
 * additionally need system.kiosks.manage (route-enforced) and pass through
 * assertApprovedOrRequest so breakglass actors still need an approved change
 * request. No elevation requirement — same posture as incident transitions.
 */

export const EXCEPTION_STATES = [
  "new", "investigating", "awaiting_device", "awaiting_support",
  "requires_financial_review", "resolved", "reopened",
] as const;
export type ExceptionState = (typeof EXCEPTION_STATES)[number];
export const isExceptionState = (v: unknown): v is ExceptionState =>
  typeof v === "string" && (EXCEPTION_STATES as readonly string[]).includes(v);

/** Legacy 0050 value — readable, mapped to canonical 'new' everywhere. */
export const LEGACY_OPEN_STATE = "open";
/** Legacy terminal state — valid in the CHECK, no outgoing transitions. */
export const LEGACY_DISMISSED_STATE = "dismissed";

/** Canonical state for display/logic; 'open' → 'new', everything else verbatim. */
export const canonicalExceptionState = (status: string | null | undefined): ExceptionState | typeof LEGACY_DISMISSED_STATE | null => {
  if (status === LEGACY_OPEN_STATE) return "new";
  if (status === LEGACY_DISMISSED_STATE) return LEGACY_DISMISSED_STATE;
  return isExceptionState(status) ? status : null;
};

/**
 * Legal lifecycle edges (validated server-side in transitionException).
 * 'reopened' is reachable only from resolved and ALWAYS requires a reason.
 * 'dismissed' (legacy) is terminal — not a key here, handled explicitly.
 */
export const EXCEPTION_TRANSITIONS: Record<ExceptionState, readonly ExceptionState[]> = {
  new: ["investigating", "awaiting_device", "awaiting_support", "requires_financial_review"],
  investigating: ["awaiting_device", "awaiting_support", "requires_financial_review", "resolved"],
  awaiting_device: ["investigating", "resolved"],
  awaiting_support: ["investigating", "resolved"],
  requires_financial_review: ["investigating", "resolved"],
  resolved: ["reopened"],
  reopened: ["investigating", "awaiting_device", "awaiting_support", "requires_financial_review", "resolved"],
};

/** Targets that require a non-empty reason (reopen must be justified). */
export const REASON_REQUIRED_TARGETS: readonly ExceptionState[] = ["reopened"];

/**
 * Kinds whose detail may involve money movement. Informational only — the
 * exception workflow never settles, refunds, or charges anything.
 */
export const FINANCIAL_EXCEPTION_KINDS = [
  "bank_mismatch", "rental_ref_mismatch", "payment_mismatch", "refund_mismatch",
] as const;

/** Known kinds emitted by the kiosk layer (kind column is free-text — this is documentation + filter chips, not a constraint). */
export const EXCEPTION_KINDS = [
  "unknown_command", "rental_ref_mismatch", "bank_mismatch", "no_matching_rental",
  "illegal_transition", "unexpected_rental_state",
  "cross_device_ack", "stale_ack", "conflicting_ack", "unexpected_ack_type",
  "unexpected_command_state", "command_timeout",
] as const;

export const MAX_EXCEPTION_NOTES = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID_RE.test(v);

export type ExceptionNote = { at: string; by: string | null; text: string };

export type ExceptionRow = {
  id: string;
  rental_id: string | null;
  kiosk_id: string | null;
  kind: string;
  detail: Record<string, unknown>;
  status: string;
  assigned_to: string | null;
  resolution_notes: string | null;
  notes: ExceptionNote[];
  created_at: string;
  updated_at: string | null;
  resolved_at: string | null;
  reopened_count: number;
};

/** List row: canonical `state` added; raw `status` kept for legacy fidelity. */
export type ExceptionListRow = ExceptionRow & { state: ExceptionState | "dismissed" | null };

const SELECT =
  "id,rental_id,kiosk_id,kind,detail,status,assigned_to,resolution_notes,notes,created_at,updated_at,resolved_at,reopened_count";

const asRow = (v: unknown): ExceptionRow | null => {
  const r = v as Partial<ExceptionRow> | null;
  if (!r || typeof r.id !== "string") return null;
  return {
    id: r.id,
    rental_id: typeof r.rental_id === "string" ? r.rental_id : null,
    kiosk_id: typeof r.kiosk_id === "string" ? r.kiosk_id : null,
    kind: typeof r.kind === "string" ? r.kind : "unknown",
    detail: r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) ? (r.detail as Record<string, unknown>) : {},
    status: typeof r.status === "string" ? r.status : "open",
    assigned_to: typeof r.assigned_to === "string" ? r.assigned_to : null,
    resolution_notes: typeof r.resolution_notes === "string" ? r.resolution_notes : null,
    notes: Array.isArray(r.notes) ? (r.notes as ExceptionNote[]) : [],
    created_at: typeof r.created_at === "string" ? r.created_at : "",
    updated_at: typeof r.updated_at === "string" ? r.updated_at : null,
    resolved_at: typeof r.resolved_at === "string" ? r.resolved_at : null,
    reopened_count: typeof r.reopened_count === "number" ? r.reopened_count : 0,
  };
};

const toListRow = (r: ExceptionRow): ExceptionListRow => ({
  ...r,
  // 'open' → 'new'; 'dismissed'/unknown pass through honestly (state may be null).
  state: canonicalExceptionState(r.status),
});

/* ── Listing ─────────────────────────────────────────────────────────────── */

export type ExceptionFilters = {
  /** Canonical state, 'active' (not resolved/dismissed), 'all', or legacy 'open'/'dismissed'. */
  state?: string;
  kind?: string;
  kioskId?: string;
  rentalId?: string;
  /** uuid to match assigned_to, or 'unassigned' for null. */
  assignedTo?: string;
  /** Only rows created more than this many hours ago. */
  olderThanHours?: number;
  limit?: number;
};

export async function listExceptions(
  db: SupabaseClient | null,
  opts: ExceptionFilters = {},
): Promise<{ configured: boolean; rows: ExceptionListRow[]; error?: string }> {
  if (!db) return { configured: false, rows: [] };
  let q = db.from("rental_exceptions").select(SELECT).order("created_at", { ascending: false });

  const state = opts.state?.trim().toLowerCase();
  if (state === "active") {
    q = q.not("status", "in", "(resolved,dismissed)");
  } else if (state === "all" || !state) {
    // no filter
  } else if (state === "new" || state === LEGACY_OPEN_STATE) {
    // Legacy 'open' rows ARE new — show both.
    q = q.in("status", ["new", LEGACY_OPEN_STATE]);
  } else if (state === LEGACY_DISMISSED_STATE || isExceptionState(state)) {
    q = q.eq("status", state);
  }
  if (opts.kind) q = q.eq("kind", opts.kind.slice(0, 80));
  if (opts.kioskId && isUuid(opts.kioskId)) q = q.eq("kiosk_id", opts.kioskId);
  if (opts.rentalId && isUuid(opts.rentalId)) q = q.eq("rental_id", opts.rentalId);
  if (opts.assignedTo === "unassigned") q = q.is("assigned_to", null);
  else if (opts.assignedTo && isUuid(opts.assignedTo)) q = q.eq("assigned_to", opts.assignedTo);
  if (typeof opts.olderThanHours === "number" && Number.isFinite(opts.olderThanHours) && opts.olderThanHours > 0) {
    const cutoff = new Date(Date.now() - opts.olderThanHours * 3600_000).toISOString();
    q = q.lt("created_at", cutoff);
  }
  const { data, error } = await q.limit(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  if (error) return { configured: true, rows: [], error: error.message };
  const rows = ((data ?? []) as unknown[]).map(asRow).filter((r): r is ExceptionRow => r !== null).map(toListRow);
  return { configured: true, rows };
}

/* ── Detail + evidence ───────────────────────────────────────────────────── */

export type ExceptionDeviceEvent = {
  id: number | string;
  slot_number: number | null;
  event_type: string;
  payload: Record<string, unknown> | null;
  occurred_at: string;
};
export type ExceptionCommand = {
  id: string; command: string; status: string;
  idempotency_key: string | null; payload: Record<string, unknown> | null;
  created_at: string; resolved_at: string | null;
};
export type ExceptionRental = {
  id: string; reference: string | null; state: string;
  power_bank_id: string | null; started_at: string | null; dispensed_at: string | null;
  returned_at: string | null; non_return_deadline: string | null;
  return_disputed: boolean | null; created_at: string;
};
export type ExceptionKiosk = {
  id: string; station_id: string; state: string; model: string | null;
  firmware_version: string | null; last_seen_at: string | null; venue_id: string | null;
};
export type ExceptionHistoryEvent = {
  id: string; actor_id: string | null; actor_role: string | null;
  action: string; detail: Record<string, unknown>; created_at: string;
};

export type ExceptionEvidence = {
  /** device_events timeline for exception.kiosk_id (newest first, ≤50). */
  device_events: ExceptionDeviceEvent[];
  /** device_commands row matching detail.command_id, when present. */
  command: ExceptionCommand | null;
  /** rentals row for exception.rental_id, when present. */
  rental: ExceptionRental | null;
  /** kiosks row for exception.kiosk_id — connectivity via last_seen_at. */
  kiosk: ExceptionKiosk | null;
  /** system_audit_events rows for resource rental_exception:<id> (newest first). */
  history: ExceptionHistoryEvent[];
  /** Non-empty when one or more evidence queries failed — honest partial state. */
  warnings: string[];
};

export type ExceptionDetail = {
  exception: ExceptionListRow;
  evidence: ExceptionEvidence;
};

const cleanJson = (v: unknown): Record<string, unknown> | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  // Reuse the audit sanitizer so payloads never leak secrets to the console.
  return sanitizeAuditDetail(v as Record<string, unknown>);
};

export async function getException(db: SupabaseClient, id: string): Promise<ExceptionDetail | null> {
  const { data, error } = await db.from("rental_exceptions").select(SELECT).eq("id", id).maybeSingle();
  if (error || !data) return null;
  const row = asRow(data);
  if (!row) return null;
  const exception = toListRow(row);

  const warnings: string[] = [];
  const commandId = typeof row.detail.command_id === "string" && isUuid(row.detail.command_id) ? row.detail.command_id : null;

  const [eventsRes, commandRes, rentalRes, kioskRes, historyRes] = await Promise.all([
    row.kiosk_id
      ? db.from("device_events")
          .select("id,slot_number,event_type,payload,occurred_at")
          .eq("kiosk_id", row.kiosk_id)
          .order("occurred_at", { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [], error: null }),
    commandId
      ? db.from("device_commands")
          .select("id,command,status,idempotency_key,payload,created_at,resolved_at")
          .eq("id", commandId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    row.rental_id
      ? db.from("rentals")
          .select("id,reference,state,power_bank_id,started_at,dispensed_at,returned_at,non_return_deadline,return_disputed,created_at")
          .eq("id", row.rental_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    row.kiosk_id
      ? db.from("kiosks")
          .select("id,station_id,state,model,firmware_version,last_seen_at,venue_id")
          .eq("id", row.kiosk_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db.from("system_audit_events")
      .select("id,actor_id,actor_role,action,detail,created_at")
      .eq("resource", `rental_exception:${row.id}`)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  if (eventsRes.error) warnings.push(`device_events: ${eventsRes.error.message}`);
  if (commandRes.error) warnings.push(`device_commands: ${commandRes.error.message}`);
  if (rentalRes.error) warnings.push(`rentals: ${rentalRes.error.message}`);
  if (kioskRes.error) warnings.push(`kiosks: ${kioskRes.error.message}`);
  if (historyRes.error) warnings.push(`system_audit_events: ${historyRes.error.message}`);

  const device_events = ((eventsRes.data ?? []) as Record<string, unknown>[]).map((e) => ({
    id: (e.id as number | string) ?? 0,
    slot_number: typeof e.slot_number === "number" ? e.slot_number : null,
    event_type: typeof e.event_type === "string" ? e.event_type : "unknown",
    payload: cleanJson(e.payload),
    occurred_at: typeof e.occurred_at === "string" ? e.occurred_at : "",
  }));

  const cmd = commandRes.data as Record<string, unknown> | null;
  const command: ExceptionCommand | null = cmd
    ? {
        id: String(cmd.id),
        command: typeof cmd.command === "string" ? cmd.command : "unknown",
        status: typeof cmd.status === "string" ? cmd.status : "unknown",
        idempotency_key: typeof cmd.idempotency_key === "string" ? cmd.idempotency_key : null,
        payload: cleanJson(cmd.payload),
        created_at: typeof cmd.created_at === "string" ? cmd.created_at : "",
        resolved_at: typeof cmd.resolved_at === "string" ? cmd.resolved_at : null,
      }
    : null;

  const rent = rentalRes.data as Record<string, unknown> | null;
  const rental: ExceptionRental | null = rent
    ? {
        id: String(rent.id),
        reference: typeof rent.reference === "string" ? rent.reference : null,
        state: typeof rent.state === "string" ? rent.state : "unknown",
        power_bank_id: typeof rent.power_bank_id === "string" ? rent.power_bank_id : null,
        started_at: typeof rent.started_at === "string" ? rent.started_at : null,
        dispensed_at: typeof rent.dispensed_at === "string" ? rent.dispensed_at : null,
        returned_at: typeof rent.returned_at === "string" ? rent.returned_at : null,
        non_return_deadline: typeof rent.non_return_deadline === "string" ? rent.non_return_deadline : null,
        return_disputed: typeof rent.return_disputed === "boolean" ? rent.return_disputed : null,
        created_at: typeof rent.created_at === "string" ? rent.created_at : "",
      }
    : null;

  const kis = kioskRes.data as Record<string, unknown> | null;
  const kiosk: ExceptionKiosk | null = kis
    ? {
        id: String(kis.id),
        station_id: typeof kis.station_id === "string" ? kis.station_id : "unknown",
        state: typeof kis.state === "string" ? kis.state : "unknown",
        model: typeof kis.model === "string" ? kis.model : null,
        firmware_version: typeof kis.firmware_version === "string" ? kis.firmware_version : null,
        last_seen_at: typeof kis.last_seen_at === "string" ? kis.last_seen_at : null,
        venue_id: typeof kis.venue_id === "string" ? kis.venue_id : null,
      }
    : null;

  const history = ((historyRes.data ?? []) as Record<string, unknown>[]).map((h) => ({
    id: String(h.id),
    actor_id: typeof h.actor_id === "string" ? h.actor_id : null,
    actor_role: typeof h.actor_role === "string" ? h.actor_role : null,
    action: typeof h.action === "string" ? h.action : "unknown",
    detail: cleanJson(h.detail) ?? {},
    created_at: typeof h.created_at === "string" ? h.created_at : "",
  }));

  return { exception, evidence: { device_events, command, rental, kiosk, history, warnings } };
}

/* ── Mutations ───────────────────────────────────────────────────────────── */

export type ExceptionMutationResult =
  | { ok: true; exception: ExceptionListRow; changeRequestId: string | null; financialReviewRequired?: boolean }
  | { ok: false; status: number; error: string; reason?: string; allowed?: readonly string[] };

async function loadExceptionOr404(
  db: SupabaseClient,
  id: string,
): Promise<{ row: ExceptionRow } | { error: { status: number; error: string } }> {
  const { data, error } = await db.from("rental_exceptions").select(SELECT).eq("id", id).maybeSingle();
  if (error) return { error: { status: 500, error: error.message } };
  const row = asRow(data);
  if (!row) return { error: { status: 404, error: "Exception not found" } };
  return { row };
}

/** True when this exception's kind/flags touch money — informational only. */
export function financialReviewInvolved(row: Pick<ExceptionRow, "kind" | "detail">, fromState?: string | null): boolean {
  return (
    (FINANCIAL_EXCEPTION_KINDS as readonly string[]).includes(row.kind) ||
    row.detail?.financial_review === true ||
    row.detail?.financial_review_required === true ||
    fromState === "requires_financial_review"
  );
}

export const transitionExceptionSchema = z.object({
  to_status: z.enum(EXCEPTION_STATES),
  reason: z.string().trim().max(1000).optional(),
  resolution_notes: z.string().trim().max(4000).optional(),
});
export type TransitionExceptionInput = z.infer<typeof transitionExceptionSchema>;

/**
 * Moves an exception along EXCEPTION_TRANSITIONS. Illegal edges → 409 (with
 * allowed targets); 'reopened' requires a reason (422). Routed through
 * assertApprovedOrRequest (risk: low) — breakglass actors get a pending change
 * request instead of execution. Every executed transition updates the row,
 * persists financial-review flags into detail, and writes a system audit event.
 * Resolving NEVER touches money — fin_cases owns financial decisions.
 */
export async function transitionException(
  db: SupabaseClient,
  actor: SystemActor,
  id: string,
  to: ExceptionState,
  opts: { reason?: string; resolutionNotes?: string } = {},
): Promise<ExceptionMutationResult> {
  const loaded = await loadExceptionOr404(db, id);
  if ("error" in loaded) return { ok: false, status: loaded.error.status, error: loaded.error.error };
  const row = loaded.row;

  const from = canonicalExceptionState(row.status);
  if (!from) return { ok: false, status: 409, error: `Exception has non-lifecycle status "${row.status}"` };
  if (from === LEGACY_DISMISSED_STATE) {
    return { ok: false, status: 409, error: "dismissed_exceptions_are_terminal", reason: "Legacy dismissed exceptions cannot transition." };
  }
  if (from === to) return { ok: false, status: 409, error: `Exception is already ${to}`, allowed: EXCEPTION_TRANSITIONS[from] };
  const allowed = EXCEPTION_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    return { ok: false, status: 409, error: `Illegal transition ${from} → ${to}`, allowed };
  }
  const reason = opts.reason?.trim() ?? "";
  if (REASON_REQUIRED_TARGETS.includes(to) && reason.length < 3) {
    return { ok: false, status: 422, error: "reason_required", reason: "Reopening an exception requires a reason (min 3 chars)." };
  }

  const action = `exception.transition:${row.id}:${from}_to_${to}`;
  const approval = await assertApprovedOrRequest(db, actor, {
    action,
    risk: "low",
    justification: reason || `Transition exception ${row.id.slice(0, 8)} (${row.kind}) ${from} → ${to}.`,
  });
  if (approval.status === "pending") {
    await systemAudit(db, { actor, action: "exception.transition_pending", resource: `rental_exception:${row.id}`, detail: { changeRequestId: approval.changeRequestId, from, to } });
    return { ok: false, status: 202, error: "approval_required", reason: "Change request created — transition executes after approval." };
  }
  if (approval.status === "error") return { ok: false, status: 500, error: approval.error };

  const now = new Date().toISOString();
  const financial = financialReviewInvolved(row, from);
  const detail = { ...row.detail };
  let detailChanged = false;
  if (to === "requires_financial_review" && detail.financial_review !== true) {
    detail.financial_review = true;
    detailChanged = true;
  }
  if (to === "resolved" && financial && detail.financial_review_required !== true) {
    // Persist the flag so the record itself shows money review is still owed —
    // resolution closes the investigation, never the financial question.
    detail.financial_review_required = true;
    detailChanged = true;
  }

  const patch: Record<string, unknown> = { status: to, updated_at: now };
  if (to === "resolved") {
    patch.resolved_at = now;
    const notes = opts.resolutionNotes?.trim();
    if (notes) patch.resolution_notes = scrub(notes, 4000);
  }
  if (from === "resolved" || to === "reopened") {
    patch.resolved_at = null;
  }
  if (to === "reopened") patch.reopened_count = row.reopened_count + 1;
  if (detailChanged) patch.detail = detail;

  const { data: updated, error: upErr } = await db
    .from("rental_exceptions")
    .update(patch)
    .eq("id", row.id)
    .select(SELECT)
    .single();
  if (upErr) return { ok: false, status: 500, error: upErr.message };
  const next = asRow(updated) ?? { ...row, ...patch } as ExceptionRow;

  await systemAudit(db, {
    actor,
    action: "exception.transitioned",
    resource: `rental_exception:${row.id}`,
    detail: {
      kind: row.kind, from, to, reason: reason || undefined,
      financial_review_required: financial || undefined,
      changeRequestId: approval.changeRequestId,
    },
  });
  return { ok: true, exception: toListRow(next), changeRequestId: approval.changeRequestId, financialReviewRequired: financial };
}

export const assignExceptionSchema = z.object({
  assigned_to: z.string().uuid().nullable(),
});

/** Assigns (or clears, null) the exception owner. Verifies the profile exists. */
export async function assignException(
  db: SupabaseClient,
  actor: SystemActor,
  id: string,
  assignedTo: string | null,
): Promise<ExceptionMutationResult> {
  const loaded = await loadExceptionOr404(db, id);
  if ("error" in loaded) return { ok: false, status: loaded.error.status, error: loaded.error.error };
  const row = loaded.row;

  if (assignedTo) {
    const { data: profile, error: pErr } = await db.from("profiles").select("id").eq("id", assignedTo).maybeSingle();
    if (pErr) return { ok: false, status: 500, error: pErr.message };
    if (!profile) return { ok: false, status: 400, error: "assigned_to does not match a known profile" };
  }

  const approval = await assertApprovedOrRequest(db, actor, {
    action: `exception.assign:${row.id}`,
    risk: "low",
    justification: `Assign exception ${row.id.slice(0, 8)} (${row.kind}) ${assignedTo ? `to ${assignedTo}` : "to unassigned"}.`,
  });
  if (approval.status === "pending") {
    await systemAudit(db, { actor, action: "exception.assign_pending", resource: `rental_exception:${row.id}`, detail: { changeRequestId: approval.changeRequestId, assigned_to: assignedTo } });
    return { ok: false, status: 202, error: "approval_required", reason: "Change request created — assignment executes after approval." };
  }
  if (approval.status === "error") return { ok: false, status: 500, error: approval.error };

  const { data: updated, error: upErr } = await db
    .from("rental_exceptions")
    .update({ assigned_to: assignedTo, updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .select(SELECT)
    .single();
  if (upErr) return { ok: false, status: 500, error: upErr.message };
  const next = asRow(updated) ?? row;

  await systemAudit(db, {
    actor, action: "exception.assigned", resource: `rental_exception:${row.id}`,
    detail: { kind: row.kind, assigned_to: assignedTo, changeRequestId: approval.changeRequestId },
  });
  return { ok: true, exception: toListRow(next), changeRequestId: approval.changeRequestId };
}

export const addExceptionNoteSchema = z.object({
  text: z.string().trim().min(1).max(2000),
});

/** Appends an investigation note to the row's notes thread (capped). */
export async function addExceptionNote(
  db: SupabaseClient,
  actor: SystemActor,
  id: string,
  text: string,
): Promise<ExceptionMutationResult> {
  const loaded = await loadExceptionOr404(db, id);
  if ("error" in loaded) return { ok: false, status: loaded.error.status, error: loaded.error.error };
  const row = loaded.row;
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, status: 422, error: "note_empty" };
  if (row.notes.length >= MAX_EXCEPTION_NOTES) {
    return { ok: false, status: 409, error: "note_limit", reason: `Exception already has ${MAX_EXCEPTION_NOTES} notes.` };
  }

  const approval = await assertApprovedOrRequest(db, actor, {
    action: `exception.note:${row.id}`,
    risk: "low",
    justification: `Add investigation note to exception ${row.id.slice(0, 8)} (${row.kind}).`,
  });
  if (approval.status === "pending") {
    await systemAudit(db, { actor, action: "exception.note_pending", resource: `rental_exception:${row.id}`, detail: { changeRequestId: approval.changeRequestId } });
    return { ok: false, status: 202, error: "approval_required", reason: "Change request created — note executes after approval." };
  }
  if (approval.status === "error") return { ok: false, status: 500, error: approval.error };

  const note: ExceptionNote = { at: new Date().toISOString(), by: actor.id, text: scrub(trimmed, 1000) };
  const notes = [...row.notes, note];
  const { data: updated, error: upErr } = await db
    .from("rental_exceptions")
    .update({ notes, updated_at: note.at })
    .eq("id", row.id)
    .select(SELECT)
    .single();
  if (upErr) return { ok: false, status: 500, error: upErr.message };
  const next = asRow(updated) ?? { ...row, notes };

  await systemAudit(db, {
    actor, action: "exception.note_added", resource: `rental_exception:${row.id}`,
    detail: { kind: row.kind, note_count: notes.length, changeRequestId: approval.changeRequestId },
  });
  return { ok: true, exception: toListRow(next), changeRequestId: approval.changeRequestId };
}

/* ── API schema (PATCH discriminated union) ──────────────────────────────── */

export const exceptionPatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("transition"),
    to_status: z.enum(EXCEPTION_STATES),
    reason: z.string().trim().max(1000).optional(),
    resolution_notes: z.string().trim().max(4000).optional(),
  }),
  z.object({ action: z.literal("assign"), assigned_to: z.string().uuid().nullable() }),
  z.object({ action: z.literal("note"), text: z.string().trim().min(1).max(2000) }),
]);
export type ExceptionPatch = z.infer<typeof exceptionPatchSchema>;
