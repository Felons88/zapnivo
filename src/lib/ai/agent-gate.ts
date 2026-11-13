import { authorizeAgent } from "./authorization";
import type { AgentGateFn, AgentGateResult } from "./authorization";

/**
 * Kill-switch gate for live AI features. The /admin/ai control center toggles
 * `ai_agents.enabled`; these helpers map each AI surface to its agent id and
 * every execution path MUST pass authorizeAgent() (fail-CLOSED) before any
 * model call, tool call, or private-data retrieval.
 *
 * Agent mapping (seed ids in src/lib/agents/registry.ts):
 *  - anonymous support chat      → "support.public"
 *  - signed-in support chat      → "support.customer"
 *  - helpdesk customer tickets   → "support.customer"
 *  - helpdesk partner tickets    → "partner.support"
 *  - general-inbox receptionist  → "receptionist.general"
 *
 * Failure policy — FAIL CLOSED, deliberately (phase 2.7 security fix):
 *  - No Supabase client, query error, timeout, missing row, or malformed row
 *    all mean authorization CANNOT be verified → the agent does not run.
 *  - "disabled" (row read OK, enabled=false) is a quiet deny; every other
 *    denial reason is a warning-severity security/availability event.
 *  - There is NO cache: the enabled flag is read fresh on every invocation,
 *    so a kill switch takes effect on the next call.
 */
export const ASSISTANT_AGENT_PUBLIC = "support.public";
export const ASSISTANT_AGENT_CUSTOMER = "support.customer";
export const RECEPTIONIST_AGENT = "receptionist.general";

export const assistantAgentId = (actor: unknown): string => (actor ? ASSISTANT_AGENT_CUSTOMER : ASSISTANT_AGENT_PUBLIC);

export const helpdeskAgentId = (requesterType: string): string => (requesterType === "partner" ? "partner.support" : "support.customer");

export { authorizeAgent, agentAllowed, agentDenied, defaultAgentGate } from "./authorization";
export type { AgentDenyReason, AgentGateFn, AgentGateResult } from "./authorization";

/**
 * Injectable check: tests pass a stub; production callers omit `db`/`gate` to
 * use the service client. Never throws — every failure is a denial verdict.
 */
export async function agentGateCheck(agentId: string): Promise<AgentGateResult> {
  return authorizeAgent(agentId);
}
