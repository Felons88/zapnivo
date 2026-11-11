import { sendToCustomer } from "../email-triggers";
import type { ReceptionistCategory } from "./types";

/**
 * Draft handling + autonomy gating + outbound sending for the receptionist.
 *
 * Hard rules (enforced here, not in prompts):
 *  - Autonomy 0: classify only — never drafts, never sends.
 *  - Autonomy 1 (default): drafts are stored for staff review; nothing sends
 *    without a human clicking approve.
 *  - Autonomy 2: auto-send ONLY for whitelisted low-risk categories
 *    ({general}) with confidence >= 0.9 AND a clean injection scan.
 *  - The AI never issues refunds or takes financial actions — the model is
 *    instructed not to promise them, and escalated categories never draft.
 */

export type DraftDecision =
  | { action: "none"; status: "awaiting_approval"; reason: string }
  | { action: "store_draft"; status: "draft_ready" }
  | { action: "auto_send"; status: "waiting" }
  | { action: "escalate"; status: "awaiting_approval"; reason: string };

export type DecisionInput = {
  autonomyLevel: number; // 0|1|2 (clamped)
  category: ReceptionistCategory;
  confidence: number | null;
  hasDraft: boolean;
  escalate: boolean;
  escalationReason: string | null;
  injectionFlagged: boolean;
  aiAvailable: boolean;
};

const level = (n: number) => Math.min(2, Math.max(0, Math.floor(n)));

export function decideDraftAction(input: DecisionInput): DraftDecision {
  const aut = level(input.autonomyLevel);
  if (input.escalate || input.injectionFlagged) {
    return { action: "escalate", status: "awaiting_approval", reason: input.escalationReason ?? (input.injectionFlagged ? "injection_flags" : "model_escalation") };
  }
  if (aut === 0) return { action: "none", status: "awaiting_approval", reason: "autonomy_classify_only" };
  if (!input.aiAvailable) return { action: "none", status: "awaiting_approval", reason: "ai_unavailable" };
  if (!input.hasDraft) return { action: "none", status: "awaiting_approval", reason: "no_draft" };
  // Autonomy 2 auto-send: whitelisted category + high confidence + clean scan.
  if (
    aut >= 2 &&
    input.category === "general" &&
    (input.confidence ?? 0) >= 0.9 &&
    !input.injectionFlagged
  ) {
    return { action: "auto_send", status: "waiting" };
  }
  return { action: "store_draft", status: "draft_ready" };
}

/** Env-driven default autonomy for NEW threads (0|1|2; default 1). */
export function defaultAutonomyLevel(): number {
  const raw = process.env.RECEPTIONIST_AUTONOMY;
  const n = raw === undefined ? 1 : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(2, Math.max(0, n)) : 1;
}

export const RECEPTIONIST_SENDER = "general" as const;

export type OutboundResult = { ok: boolean; error?: string };

/**
 * Queues an outbound email to the general correspondent via the existing
 * helpdesk outbox (sender id "general" → hello@zapnivo.com identity) and
 * flushes it. Returns ok:false when the mail backend isn't configured — the
 * caller records the failure honestly; nothing is claimed as sent.
 */
export async function queueReceptionistEmail(
  to: string,
  subject: string,
  body: string,
): Promise<OutboundResult> {
  const ok = await sendToCustomer(to, subject, body, null, null, {
    sender: RECEPTIONIST_SENDER,
    template: "receptionist_reply",
    event: "receptionist.reply",
  });
  return ok ? { ok: true } : { ok: false, error: "mail_backend_unavailable" };
}
