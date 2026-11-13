import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "../supabase";
import { recordLog, reportError } from "../observability";

/**
 * FAIL-CLOSED agent authorization (phase 2.7 security fix).
 *
 * Every AI execution path must call authorizeAgent() (directly or via an
 * AgentGateFn) BEFORE any model call, tool call, or private-data retrieval.
 * The check is a fresh DB read of ai_agents on every invocation — there is
 * deliberately NO cache, so an operator kill switch takes effect on the very
 * next call.
 *
 * Verdicts:
 *  - allowed        → row exists, enabled === true (strict boolean).
 *  - "disabled"     → row read successfully, enabled === false. Normal
 *                     operator action: quiet deny + info-level audit-lite log.
 *                     Never pages anyone.
 *  - "missing"      → no ai_agents row for this id. Cannot verify → deny.
 *  - "unavailable"  → no DB client, query error, exception, or timeout.
 *                     Cannot verify → deny.
 *  - "invalid_row"  → row exists but enabled is not a boolean / id mismatch.
 *                     Malformed → deny.
 *
 * "missing"/"unavailable"/"invalid_row" are authorization-UNVERIFIABLE: they
 * record a warning-level app_log AND a warning-severity error_events issue
 * (alert-worthy). Events carry the agent id + reason class ONLY — never
 * prompts, messages, or customer data.
 */

export type AgentDenyReason = "disabled" | "missing" | "unavailable" | "invalid_row";

export type AgentGateResult =
  | { allowed: true; agentId: string }
  | { allowed: false; agentId: string; reason: AgentDenyReason };

/** Injectable authorization check. Production default: authorizeAgent via the service client. */
export type AgentGateFn = (agentId: string) => Promise<AgentGateResult>;

/** Test/stub helpers — prefer these over hand-rolled literals. */
export const agentAllowed = (agentId = "test.agent"): AgentGateResult => ({ allowed: true, agentId });
export const agentDenied = (agentId: string, reason: AgentDenyReason = "disabled"): AgentGateResult => ({ allowed: false, agentId, reason });

const GATE_TIMEOUT_MS = 5_000;

function recordDenial(agentId: string, reason: AgentDenyReason, surface: string): void {
  if (reason === "disabled") {
    // Operator-disabled is routine: info-level audit-lite only, no alerting.
    recordLog("info", "ai.agent_denied", { service: "ai-gate", attrs: { agent: agentId, reason, surface } });
    return;
  }
  // Authorization could not be verified — alert-worthy. Sanitized: id + reason class only.
  recordLog("warning", "ai.authorization_unverifiable", { service: "ai-gate", attrs: { agent: agentId, reason, surface } });
  reportError(new Error(`ai_authorization_unverifiable:${reason}`), {
    severity: "warning",
    route: "ai/authorization",
    attrs: { agent: agentId, reason, surface },
  });
}

/**
 * Fresh per-execution authorization read. `db` mirrors the old isAgentEnabled
 * convention: undefined → service client, explicit null → treated as
 * unverifiable (deny). Never throws — every failure path returns a denial.
 */
export async function authorizeAgent(
  agentId: string,
  db?: SupabaseClient | null,
  surface = "ai",
): Promise<AgentGateResult> {
  const id = String(agentId ?? "").slice(0, 120);
  const deny = (reason: AgentDenyReason): AgentGateResult => {
    recordDenial(id, reason, surface);
    return { allowed: false, agentId: id, reason };
  };
  if (!id) return deny("invalid_row");

  const client = db === undefined ? serviceClient() : db;
  if (!client) return deny("unavailable");

  let data: unknown;
  let error: { message?: string } | null = null;
  try {
    const res = await Promise.race([
      client.from("ai_agents").select("id,enabled").eq("id", id).maybeSingle(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ai_gate_timeout")), GATE_TIMEOUT_MS)),
    ]);
    data = res.data;
    error = res.error;
  } catch {
    return deny("unavailable");
  }
  if (error) return deny("unavailable");
  if (data == null) return deny("missing");

  const row = data as { id?: unknown; enabled?: unknown };
  if (typeof row.enabled !== "boolean" || String(row.id ?? "") !== id) return deny("invalid_row");
  if (!row.enabled) return deny("disabled");
  return { allowed: true, agentId: id };
}

/** Production default gate: fresh service-client read per call. No caching. */
export const defaultAgentGate: AgentGateFn = (agentId) => authorizeAgent(agentId);
