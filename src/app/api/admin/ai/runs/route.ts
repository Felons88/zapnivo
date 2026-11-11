import { NextResponse } from "next/server";
import { listRuns, scrubError } from "@/lib/agents/registry";
import { aiGuard } from "../_shared";

/** Recent agent runs. Error text is scrubbed again server-side (defense in depth). */
export async function GET(req: Request) {
  const g = await aiGuard();
  if (!g.ok) return g.res;
  const url = new URL(req.url);
  const agent = url.searchParams.get("agent")?.trim() || undefined;
  const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
  const runs = await listRuns(g.db, { agentId: agent, limit });
  return NextResponse.json({
    runs: runs.map((r) => ({ ...r, error: r.error ? scrubError(r.error) : null })),
  });
}
