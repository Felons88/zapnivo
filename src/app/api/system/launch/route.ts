import { NextResponse } from "next/server";
import { systemApiGuard } from "../_shared";
import { launchReadiness } from "@/lib/system/launch";

export async function GET() {
  const g = await systemApiGuard("system.dashboard.view");
  if (!g.ok) return g.res;
  return NextResponse.json(await launchReadiness(g.db));
}
