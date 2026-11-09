import type { HelpdeskRepo } from "./repo";
import { slaStatus } from "./sla";
import type { Queue, Ticket } from "./types";

export type Metrics = {
  open: number;
  needsHuman: number;
  unassigned: number;
  urgent: number;
  overdueFirstResponse: number;
  overdueResolution: number;
  byQueue: Record<Queue, number>;
  avgFirstResponseHours: number | null;
  resolved: number;
  aiResolved: number;
  aiDeflectionRate: number | null;
  refunds: { requested: number; approved: number; issued: number; denied: number; failed: number; issuedCents: number };
};

const ACTIVE = (t: Ticket) => t.state !== "resolved" && t.state !== "closed";

/** Computed from real ticket data only. No data → zeros/nulls, never invented figures. */
export async function computeMetrics(repo: HelpdeskRepo, now = new Date()): Promise<Metrics> {
  const tickets = await repo.listTickets({ limit: 1000 });
  const refunds = await repo.listRefunds();
  const active = tickets.filter(ACTIVE);
  const humanTickets = active.filter((t) => t.aiState !== "ai_active");

  const frs = tickets.filter((t) => t.firstResponseAt).map((t) => (Date.parse(t.firstResponseAt!) - Date.parse(t.createdAt)) / 3600_000);
  const resolved = tickets.filter((t) => !ACTIVE(t));
  const aiResolved = resolved.filter((t) => t.aiState === "ai_active").length;

  const byQueue: Record<Queue, number> = { customer: 0, billing: 0, partner: 0, safety: 0 };
  active.forEach((t) => byQueue[t.queue]++);

  return {
    open: active.length,
    needsHuman: active.filter((t) => t.aiState === "needs_human").length,
    unassigned: active.filter((t) => !t.assignedTo && t.aiState !== "ai_active").length,
    urgent: active.filter((t) => t.priority === "urgent").length,
    overdueFirstResponse: humanTickets.filter((t) => slaStatus(t, now).firstResponse === "breached").length,
    overdueResolution: humanTickets.filter((t) => slaStatus(t, now).resolution === "breached").length,
    byQueue,
    avgFirstResponseHours: frs.length ? Math.round((frs.reduce((s, x) => s + x, 0) / frs.length) * 10) / 10 : null,
    resolved: resolved.length,
    aiResolved,
    aiDeflectionRate: resolved.length ? Math.round((aiResolved / resolved.length) * 100) : null,
    refunds: {
      requested: refunds.filter((r) => r.status === "requested").length, approved: refunds.filter((r) => r.status === "approved").length,
      issued: refunds.filter((r) => r.status === "issued").length, denied: refunds.filter((r) => r.status === "denied").length, failed: refunds.filter((r) => r.status === "failed").length,
      issuedCents: refunds.filter((r) => r.status === "issued").reduce((s, r) => s + r.amountCents, 0),
    },
  };
}
