import { describe, expect, it } from "vitest";
import { derivePipeline, monthlyCommission, summarizePartnerSla } from "../src/lib/partner-ops";
import type { Ticket } from "../src/lib/helpdesk/types";

describe("derivePipeline", () => {
  const base = { orgName: "Demo Tavern", applications: [], agreementCount: 0, venues: [], kiosks: [] };
  it("is empty with no rows", () => {
    const p = derivePipeline(base);
    expect(p.doneCount).toBe(0);
    expect(p.next).toBe("Application approved");
  });
  it("advances from real rows", () => {
    const p = derivePipeline({ ...base, applications: [{ business_name: " demo  tavern ", status: "approved" }], agreementCount: 1, venues: [{ published: false }], kiosks: [{ installed_at: "2025-01-01" }] });
    expect(p.doneCount).toBe(4);
    expect(p.next).toBe("Venue published");
  });
  it("ignores unapproved or other-org applications", () => {
    expect(derivePipeline({ ...base, applications: [{ business_name: "Demo Tavern", status: "new" }, { business_name: "Other", status: "approved" }] }).doneCount).toBe(0);
  });
});

const T = (o: Partial<Ticket>): Ticket => ({
  id: "1", number: "T1", requesterType: "partner", name: "", email: "", phone: null, orgId: "o1", venueId: null, venueLabel: null, category: "", subject: "",
  queue: "partner", state: "open", priority: "normal", assignedTo: null, aiState: "none", aiSummary: null, rentalRef: null, stationLabel: null, attachmentPath: null,
  createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z", firstResponseAt: null,
  firstResponseDueAt: "2025-01-02T00:00:00Z", resolutionDueAt: "2025-01-06T00:00:00Z", resolvedAt: null, ...o,
});

describe("summarizePartnerSla", () => {
  it("handles empty", () => {
    const s = summarizePartnerSla([]);
    expect(s.total).toBe(0);
    expect(s.avgFirstResponseHours).toBeNull();
  });
  it("computes averages, breaches and per-org counts; ignores other queues", () => {
    const now = new Date("2025-02-01T00:00:00Z");
    const s = summarizePartnerSla([
      T({ id: "a", firstResponseAt: "2025-01-01T04:00:00Z", resolvedAt: "2025-01-02T00:00:00Z", state: "resolved" }),
      T({ id: "b", orgId: "o2" }),
      T({ id: "c", queue: "customer" }),
    ], now);
    expect(s.total).toBe(2);
    expect(s.avgFirstResponseHours).toBe(4);
    expect(s.avgResolutionHours).toBe(24);
    expect(s.firstResponseBreaches).toBe(1);
    expect(s.perOrg.find((o) => o.orgId === "o2")?.breaches).toBe(1);
    expect(s.perOrg.find((o) => o.orgId === "o1")?.breaches).toBe(0);
  });
});

describe("monthlyCommission", () => {
  it("buckets last 6 months oldest first", () => {
    const b = monthlyCommission([{ period: "2025-06-01", commission_cents: 100 }, { period: "2025-06-01", commission_cents: 50 }, { period: "2024-01-01", commission_cents: 9 }], 6, new Date("2025-06-15T00:00:00Z"));
    expect(b).toHaveLength(6);
    expect(b[0].key).toBe("2025-01");
    expect(b[5].cents).toBe(150);
  });
});
