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
