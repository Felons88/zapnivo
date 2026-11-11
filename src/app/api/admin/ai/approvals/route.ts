import { NextResponse } from "next/server";
import { listApprovals } from "@/lib/agents/registry";
import { aiGuard } from "../_shared";

/** Pending human-approval queue for agent-proposed actions. */
export async function GET() {
  const g = await aiGuard();
  if (!g.ok) return g.res;
  const approvals = await listApprovals(g.db, "pending", 100);
  return NextResponse.json({ approvals });
}
