import { slaStatus } from "./helpdesk/sla";
import type { Ticket } from "./helpdesk/types";

/** Pure partner-operations logic (no I/O) so it can be unit tested. */

export const PIPELINE_STAGES = [
  { key: "approved", label: "Application approved" },
  { key: "agreement", label: "Agreement recorded" },
  { key: "venue", label: "Venue created" },
  { key: "installed", label: "Kiosk installed" },
  { key: "published", label: "Venue published" },
] as const;
export type StageKey = (typeof PIPELINE_STAGES)[number]["key"];

export const MANUAL_STEPS = [
  { key: "welcome_call", label: "Welcome call held" },
  { key: "site_survey", label: "Site survey done" },
  { key: "signage_sent", label: "Signage sent" },
  { key: "staff_training", label: "Venue staff briefed" },
  { key: "go_live_check", label: "Go-live check complete" },
] as const;
export type ManualStepKey = (typeof MANUAL_STEPS)[number]["key"];
export const isManualStep = (s: string): s is ManualStepKey => MANUAL_STEPS.some((m) => m.key === s);

export const DOC_KINDS = { insurance_certificate: "Insurance certificate", w9: "W-9", business_license: "Business license", other: "Other document" } as const;
export type DocKind = keyof typeof DOC_KINDS;

export type PipelineInput = {
  orgName: string;
  applications: { business_name: string; status: string }[];
  agreementCount: number;
  venues: { published: boolean }[];
  kiosks: { installed_at: string | null }[];
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Derived from real rows only. Applications are matched to the organization by business name (no FK exists). */
export function derivePipeline(i: PipelineInput): { stages: { key: StageKey; label: string; done: boolean }[]; doneCount: number; next: string | null } {
  const done: Record<StageKey, boolean> = {
    approved: i.applications.some((a) => norm(a.business_name) === norm(i.orgName) && (a.status === "approved" || a.status === "installed")),
    agreement: i.agreementCount > 0,
    venue: i.venues.length > 0,
    installed: i.kiosks.some((k) => !!k.installed_at),
    published: i.venues.some((v) => v.published),
  };
  const stages = PIPELINE_STAGES.map((s) => ({ ...s, done: done[s.key] }));
  const next = stages.find((s) => !s.done)?.label ?? null;
  return { stages, doneCount: stages.filter((s) => s.done).length, next };
}

export type SlaSummary = {
  total: number; open: number; responded: number; resolved: number;
  avgFirstResponseHours: number | null; avgResolutionHours: number | null;
  firstResponseBreaches: number; resolutionBreaches: number;
  perOrg: { orgId: string | null; total: number; open: number; breaches: number }[];
};

const hours = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3600_000;
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);

/** Partner-queue SLA math. Breach = response/resolution later than its due date, or still pending past due. */
export function summarizePartnerSla(tickets: Ticket[], now = new Date()): SlaSummary {
  const partner = tickets.filter((t) => t.queue === "partner");
  const isOpen = (t: Ticket) => t.state !== "resolved" && t.state !== "closed";
  const orgs = new Map<string, { orgId: string | null; total: number; open: number; breaches: number }>();
  let frBreach = 0, resBreach = 0;
  for (const t of partner) {
    const s = slaStatus(t, now);
    const fr = s.firstResponse === "breached", rs = s.resolution === "breached";
    if (fr) frBreach++;
    if (rs) resBreach++;
    const key = t.orgId ?? "";
    const row = orgs.get(key) ?? { orgId: t.orgId, total: 0, open: 0, breaches: 0 };
    row.total++;
    if (isOpen(t)) row.open++;
    if (fr || rs) row.breaches++;
    orgs.set(key, row);
  }
  return {
    total: partner.length, open: partner.filter(isOpen).length,
    responded: partner.filter((t) => t.firstResponseAt).length,
    resolved: partner.filter((t) => t.resolvedAt).length,
    avgFirstResponseHours: avg(partner.filter((t) => t.firstResponseAt).map((t) => hours(t.createdAt, t.firstResponseAt!))),
    avgResolutionHours: avg(partner.filter((t) => t.resolvedAt).map((t) => hours(t.createdAt, t.resolvedAt!))),
    firstResponseBreaches: frBreach, resolutionBreaches: resBreach,
    perOrg: [...orgs.values()].sort((a, b) => b.breaches - a.breaches || b.total - a.total),
  };
}

/** Last `n` calendar months (UTC) ending at `now`, oldest first, summed from ledger rows {period:'YYYY-MM-DD', commission_cents}. */
export function monthlyCommission(rows: { period: string; commission_cents: number }[], n = 6, now = new Date()) {
  const buckets: { key: string; label: string; cents: number }[] = [];
  for (let k = n - 1; k >= 0; k--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
    buckets.push({ key: d.toISOString().slice(0, 7), label: d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }), cents: 0 });
  }
  for (const r of rows) {
    const b = buckets.find((x) => x.key === r.period.slice(0, 7));
    if (b) b.cents += r.commission_cents;
  }
  return buckets;
}

/* ─── Partner self-serve performance reporting ─────────────────────────── */

/** Rental states that mean a power bank was actually dispensed (utilization numerator). */
export const DISPENSED_RENTAL_STATES = new Set(["dispense_pending", "active", "returned", "unreturned", "charged_off"]);

export type RentalWindowRow = { state: string; created_at: string };
export type WindowStats = { rentals: number; completed: number; utilizationPct: number | null };

/** Counts rentals created in [startIso, endIso) and the share that reached a dispensed state. */
export function rentalWindowStats(rows: RentalWindowRow[], startIso: string, endIso: string): WindowStats {
  const win = rows.filter((r) => r.created_at >= startIso && r.created_at < endIso);
  const completed = win.filter((r) => DISPENSED_RENTAL_STATES.has(r.state)).length;
  return { rentals: win.length, completed, utilizationPct: win.length ? Math.round((completed / win.length) * 1000) / 10 : null };
}

export type PaymentWindowRow = { amount_captured_cents: number | null; amount_refunded_cents: number | null; created_at: string };

/** Net captured revenue (captured − refunded) for payments created in [startIso, endIso). */
export function paymentWindowStats(rows: PaymentWindowRow[], startIso: string, endIso: string): { payments: number; netCents: number } {
  const win = rows.filter((p) => p.created_at >= startIso && p.created_at < endIso);
  const netCents = win.reduce((s, p) => s + (p.amount_captured_cents ?? 0) - (p.amount_refunded_cents ?? 0), 0);
  return { payments: win.length, netCents };
}

/** Percent change current vs prior. null when there is no prior baseline to divide by (unless both are 0). */
export function pctDelta(current: number, prior: number): number | null {
  if (prior === 0) return current === 0 ? 0 : null;
  return Math.round(((current - prior) / prior) * 1000) / 10;
}

export const DEVICE_STALE_MS = 24 * 3600_000;

/** Fleet summary for a venue's devices. "stale" = status active but no heartbeat within 24h (or never). */
export function deviceStatusSummary(devices: { status: string; last_heartbeat_at: string | null }[], now = new Date()) {
  let online = 0, stale = 0, inactive = 0;
  for (const d of devices) {
    if (d.status !== "active") { inactive++; continue; }
    const hb = d.last_heartbeat_at ? Date.parse(d.last_heartbeat_at) : NaN;
    if (Number.isFinite(hb) && now.getTime() - hb <= DEVICE_STALE_MS) online++; else stale++;
  }
  return { total: devices.length, online, stale, inactive };
}

/** Neutralizes spreadsheet formula injection and quotes per RFC 4180 (same approach as the admin CSV export). */
export const csvCell = (v: unknown) => {
  let s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
export const toCsv = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return "no_rows\n";
  const cols = Object.keys(rows[0]);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
};
