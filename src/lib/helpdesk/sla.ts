import type { Priority, Ticket } from "./types";

/**
 * INTERNAL service-level targets (wall-clock hours). Used for staff queues and breach alerts.
 * These are NOT published to customers: the public site makes no response-time promises.
 */
export const SLA_HOURS: Record<Priority, { first: number; resolve: number }> = {
  urgent: { first: 1, resolve: 8 },
  high: { first: 4, resolve: 48 },
  normal: { first: 24, resolve: 120 },
  low: { first: 48, resolve: 240 },
};

const HOUR = 3600_000;

export function dueDates(priority: Priority, from: Date) {
  const s = SLA_HOURS[priority];
  return { firstResponseDueAt: new Date(from.getTime() + s.first * HOUR).toISOString(), resolutionDueAt: new Date(from.getTime() + s.resolve * HOUR).toISOString() };
}

export type SlaState = "met" | "ok" | "due_soon" | "breached" | "n/a";

function clock(due: string, done: string | null, now: Date, windowHours: number): SlaState {
  const dueMs = Date.parse(due);
  if (done) return Date.parse(done) <= dueMs ? "met" : "breached";
  const left = dueMs - now.getTime();
  if (left < 0) return "breached";
  return left < Math.max(HOUR, windowHours * HOUR * 0.2) ? "due_soon" : "ok";
}

export function slaStatus(t: Pick<Ticket, "priority" | "createdAt" | "firstResponseAt" | "firstResponseDueAt" | "resolutionDueAt" | "resolvedAt" | "state">, now = new Date()) {
  const s = SLA_HOURS[t.priority];
  return {
    firstResponse: clock(t.firstResponseDueAt, t.firstResponseAt, now, s.first),
    resolution: t.state === "closed" && !t.resolvedAt ? ("n/a" as SlaState) : clock(t.resolutionDueAt, t.resolvedAt, now, s.resolve),
  };
}

export function humanDue(due: string, now = new Date()) {
  const m = Math.round((Date.parse(due) - now.getTime()) / 60_000);
  const abs = Math.abs(m);
  const t = abs < 60 ? `${abs}m` : abs < 2880 ? `${Math.round(abs / 60)}h` : `${Math.round(abs / 1440)}d`;
  return m < 0 ? `${t} overdue` : `due in ${t}`;
}
