import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { launchReadiness } from "@/lib/system/launch";
import { getAcceptanceChecks } from "@/lib/system/acceptance";

export async function GET() {
  const g = await systemApiGuard("system.dashboard.view");
  if (!g.ok) return g.res;
  const [readiness, acceptance] = await Promise.all([launchReadiness(g.db), getAcceptanceChecks(g.db)]);
  // Additive extension: all existing LaunchReadiness keys preserved; the
  // acceptance report is exposed under `acceptance`.
  return NextResponse.json({ ...readiness, acceptance });
}
