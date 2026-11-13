import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "../supabase";
import { recordLog } from "../observability";

/**
 * Kill-switch gate for live AI features. The /admin/ai control center toggles
 * `ai_agents.enabled`; these helpers let the assistant and helpdesk honor it
 * BEFORE any model call is made.
 *
 * Agent mapping (seed ids in src/lib/agents/registry.ts):
 *  - anonymous support chat      → "support.public"
 *  - signed-in support chat      → "support.customer"
 *  - helpdesk customer tickets   → "support.customer"
 *  - helpdesk partner tickets    → "partner.support"
 *
 * Failure policy — FAIL OPEN, deliberately:
 *  - No Supabase client configured (local/dev without DB): AI stays available.
 *  - Lookup error or missing row (agents not seeded yet): AI stays available,
 *    and a warning is logged. A disabled flag is only honored when the row is
 *    actually read successfully — an operator's kill switch must work, but a
 *    telemetry/DB hiccup must not take down production AI.
 */
export const ASSISTANT_AGENT_PUBLIC = "support.public";
export const ASSISTANT_AGENT_CUSTOMER = "support.customer";

export const assistantAgentId = (actor: unknown): string => (actor ? ASSISTANT_AGENT_CUSTOMER : ASSISTANT_AGENT_PUBLIC);

export const helpdeskAgentId = (requesterType: string): string => (requesterType === "partner" ? "partner.support" : "support.customer");

/** Injectable check: tests pass a stub; production callers omit `db` to use the service client. */
export type AgentEnabledFn = (agentId: string) => Promise<boolean>;

export async function isAgentEnabled(agentId: string, db?: SupabaseClient | null): Promise<boolean> {
  const client = db === undefined ? serviceClient() : db;
  if (!client) return true;
  try {
    const { data, error } = await client.from("ai_agents").select("enabled").eq("id", agentId).maybeSingle();
    if (error) {
      recordLog("warning", "ai_agent_gate_lookup_failed", { service: "ai-gate", attrs: { agent: agentId, reason: "query_error" } });
      return true;
    }
    if (!data) return true; // agent row not seeded yet — nothing to enforce
    return (data as { enabled?: boolean }).enabled !== false;
  } catch {
    recordLog("warning", "ai_agent_gate_lookup_failed", { service: "ai-gate", attrs: { agent: agentId, reason: "exception" } });
    return true;
  }
}
