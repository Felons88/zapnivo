import { NextResponse } from "next/server";
import { agentStats, ensureSeedAgents, listAgents } from "@/lib/agents/registry";
import { aiGuard } from "../_shared";

/** Agent directory + trailing-30d stats. Seeds the registry lazily on first read. */
export async function GET() {
  const g = await aiGuard();
  if (!g.ok) return g.res;
  await ensureSeedAgents(g.db);
  const [agents, stats] = await Promise.all([listAgents(g.db), agentStats(g.db, 30)]);
  return NextResponse.json({
    agents: agents.map((a) => ({ ...a, stats: stats[a.id] ?? null })),
  });
}
