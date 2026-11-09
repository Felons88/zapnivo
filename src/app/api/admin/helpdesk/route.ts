import { z } from "zod";
import { fail, limit, needCtx, run, sameOrigin, staffActor } from "@/lib/helpdesk/http";
import { flushOutbox } from "@/lib/helpdesk/mailer";
import * as svc from "@/lib/helpdesk/service";
import { PRIORITIES, REFUND_REASONS, STATES } from "@/lib/helpdesk/types";
import { NextResponse } from "next/server";

const num = z.string().regex(/^Z-\d{3,9}$/);
const id = z.string().uuid();
const op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("reply"), number: num, body: z.string().min(1).max(4000), state: z.enum(["pending_customer", "pending_internal", "resolved"]).optional() }),
  z.object({ op: z.literal("note"), number: num, body: z.string().min(1).max(4000) }),
  z.object({ op: z.literal("assign"), number: num, assigneeId: z.string().max(80).nullable() }),
  z.object({ op: z.literal("state"), number: num, state: z.enum(STATES) }),
  z.object({ op: z.literal("priority"), number: num, priority: z.enum(PRIORITIES) }),
  z.object({ op: z.literal("draft"), number: num }),
  z.object({ op: z.literal("refund_request"), number: num, rentalRef: z.string().regex(/^ZR-[A-Z0-9]{8}$/i), reason: z.enum(REFUND_REASONS), amountCents: z.number().int().positive().max(100000), override: z.boolean().optional() }),
  z.object({ op: z.literal("refund_decide"), id, decision: z.enum(["approve", "deny"]), note: z.string().max(500).optional() }),
  z.object({ op: z.literal("refund_issue"), id }),
  z.object({ op: z.literal("refund_record"), id, providerRefundId: z.string().max(80) }),
  z.object({ op: z.literal("flush_outbox") }),
]);

/** Staff helpdesk actions. Every operation re-checks authorization in the service layer and writes an audit event. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, "Cross-origin request rejected.");
  const actor = await staffActor();
  if (!actor) return fail(403, "Staff access required.");
  if (!limit(`helpdesk:${actor.id}`, 120, 60_000).ok) return fail(429, "Slow down a little.");

  const parsed = op.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(422, "Invalid request.", { issues: parsed.error.issues.slice(0, 3).map((i) => i.message) });
  const ctx = await needCtx();
  if (ctx instanceof NextResponse) return ctx;
  const o = parsed.data;

  return run("helpdesk-admin", async () => {
    switch (o.op) {
      case "reply": await svc.agentReply(ctx, actor, o.number, o.body, o.state); return { ok: true };
      case "note": await svc.internalNote(ctx, actor, o.number, o.body); return { ok: true };
      case "assign": await svc.assign(ctx, actor, o.number, o.assigneeId); return { ok: true };
      case "state": await svc.setState(ctx, actor, o.number, o.state); return { ok: true };
      case "priority": await svc.setPriority(ctx, actor, o.number, o.priority); return { ok: true };
      case "draft": return { ok: true, ...(await svc.aiDraft(ctx, actor, o.number)) };
      case "refund_request": return { ok: true, refund: await svc.requestRefund(ctx, actor, { ...o, rentalRef: o.rentalRef.toUpperCase() }) };
      case "refund_decide": return { ok: true, refund: await svc.decideRefund(ctx, actor, o.id, o.decision, o.note) };
      case "refund_issue": return { ok: true, ...(await svc.issueRefund(ctx, actor, o.id)) };
      case "refund_record": return { ok: true, ...(await svc.markRefundIssued(ctx, actor, o.id, o.providerRefundId)) };
      case "flush_outbox": return { ok: true, ...(await flushOutbox(ctx.repo, ctx.mailer)) };
    }
  });
}
