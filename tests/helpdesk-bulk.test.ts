import { describe, expect, it } from "vitest";
import { MemoryRepo } from "@/lib/helpdesk/memory-repo";
import { sanitizeInboxQuery } from "@/lib/helpdesk/inbox-query";
import { DemoRentalDirectory } from "@/lib/helpdesk/rentals";
import * as svc from "@/lib/helpdesk/service";
import { HelpdeskError, type Actor } from "@/lib/helpdesk/types";
import { NotConfiguredRefundProvider } from "@/lib/payments/source";

const NOW = new Date("2026-11-08T12:00:00Z");
const mk = (): svc.Ctx => ({ repo: new MemoryRepo(), chat: null, mailer: null, rentals: new DemoRentalDirectory(), refunds: new NotConfiguredRefundProvider(), now: () => NOW, siteUrl: "https://z.test" });
const agent: Actor = { kind: "staff", id: "agent-1", name: "Alex", role: "staff" };
const pat: Actor = { kind: "customer", email: "pat@example.com" };
const base = { requesterType: "customer" as const, name: "Pat", email: "pat@example.com", category: "Other", description: "Where can I return my charger?" };
const make = async (c: svc.Ctx, n: number) => { const out: string[] = []; for (let i = 0; i < n; i++) out.push((await svc.createTicket(c, base)).ticket.number); return out; };

describe("bulkUpdateTickets", () => {
  it("assigns, prioritises and resolves via the single-ticket path with audit events", async () => {
    const c = mk();
    const [a, b] = await make(c, 2);
    const r = await svc.bulkUpdateTickets(c, agent, [a, b], { assigneeId: agent.id });
    expect(r.every((x) => x.ok)).toBe(true);
    const t = await c.repo.getTicketByNumber(a);
    expect(t?.assignedTo).toBe("agent-1");
    const ev = await c.repo.listEvents(t!.id);
    expect(ev.some((e) => e.type === "assigned")).toBe(true);
    await svc.bulkUpdateTickets(c, agent, [a], { priority: "urgent" });
    expect((await c.repo.getTicketByNumber(a))?.priority).toBe("urgent");
    await svc.bulkUpdateTickets(c, agent, [a, b], { state: "resolved" });
    const t2 = await c.repo.getTicketByNumber(a);
    expect(t2?.state).toBe("resolved");
    expect(t2?.resolvedAt).toBeTruthy();
  });

  it("reports partial failures honestly and dedupes", async () => {
    const c = mk();
    const [a] = await make(c, 1);
    const r = await svc.bulkUpdateTickets(c, agent, [a, "Z-999999", a], { state: "closed" });
    expect(r).toHaveLength(2);
    expect(r.find((x) => x.number === a)?.ok).toBe(true);
    expect(r.find((x) => x.number === "Z-999999")).toMatchObject({ ok: false });
  });

  it("rejects non-staff actors", async () => {
    const c = mk();
    const [a] = await make(c, 1);
    await expect(svc.bulkUpdateTickets(c, pat, [a], { state: "closed" })).rejects.toMatchObject({ code: "forbidden" });
    expect((await c.repo.getTicketByNumber(a))?.state).not.toBe("closed");
  });

  it("caps at 100 tickets and requires a selection and an action", async () => {
    const c = mk();
    const many = Array.from({ length: 101 }, (_, i) => `Z-${String(i + 1).padStart(3, "0")}`);
    await expect(svc.bulkUpdateTickets(c, agent, many, { state: "closed" })).rejects.toBeInstanceOf(HelpdeskError);
    await expect(svc.bulkUpdateTickets(c, agent, [], { state: "closed" })).rejects.toBeInstanceOf(HelpdeskError);
    await expect(svc.bulkUpdateTickets(c, agent, ["Z-001"], {})).rejects.toBeInstanceOf(HelpdeskError);
  });

  it("cannot be used to approve or issue refunds (patch has no refund fields; state limited)", async () => {
    const c = mk();
    const [a] = await make(c, 1);
    // @ts-expect-error refund fields are not part of the patch type
    await expect(svc.bulkUpdateTickets(c, agent, [a], { refund: "approve" })).rejects.toBeInstanceOf(HelpdeskError);
    // @ts-expect-error only resolved/closed are allowed bulk states
    await expect(svc.bulkUpdateTickets(c, agent, [a], { state: "open" })).rejects.toBeInstanceOf(HelpdeskError);
    expect(await c.repo.listRefunds({})).toHaveLength(0);
  });
});

describe("sanitizeInboxQuery", () => {
  it("keeps only known params with valid values", () => {
    expect(sanitizeInboxQuery("view=mine&queue=billing&q=abc&evil=1")).toBe("view=mine&queue=billing&q=abc");
    expect(sanitizeInboxQuery("view=nope&queue=x")).toBe("");
    expect(sanitizeInboxQuery("//evil.com")).toBe("");
  });
});
