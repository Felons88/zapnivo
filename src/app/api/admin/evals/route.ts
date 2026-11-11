import { NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser, isStaff } from "@/lib/auth";
import { recordLog } from "@/lib/observability";
import { DEFAULT_SCENARIOS } from "@/lib/evals/runner";

async function staff() {
  const u = await getSessionUser();
  return u && isStaff(u) ? u : null;
}

export async function GET() {
  const u = await staff();
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const [{ data: suites }, { data: runs }] = await Promise.all([
    db.from("eval_suites").select("*").order("created_at", { ascending: false }),
    db.from("eval_runs").select("*").order("created_at", { ascending: false }).limit(20),
  ]);
  return NextResponse.json({ suites: suites ?? [], runs: runs ?? [] });
}

const createSchema = z.object({
  name: z.string().min(3).max(120),
  agent_id: z.string().max(60).optional(),
  scenarios: z.array(z.object({
    id: z.string().min(1).max(80),
    input: z.string().min(1).max(2000),
    history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(2000) })).max(10).optional(),
    expect: z.object({
      forbidden: z.array(z.string().max(200)).max(10).optional(),
      required: z.array(z.string().max(200)).max(10).optional(),
      noFabrication: z.boolean().optional(),
      toolsCalled: z.array(z.string().max(60)).max(10).optional(),
    }),
    tags: z.array(z.string().max(40)).max(10).optional(),
  })).min(1).max(50),
});

export async function POST(req: Request) {
  const u = await staff();
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid suite" }, { status: 422 });
  const { data, error } = await db.from("eval_suites").insert({
    name: parsed.data.name, agent_id: parsed.data.agent_id ?? "support.public",
    scenarios: parsed.data.scenarios,
  }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  recordLog("info", "eval_suite_created", { service: "ai-evals", attrs: { suite: data.id } });
  return NextResponse.json({ suite: data }, { status: 201 });
}

/** Seed the default synthetic suite once (idempotent by name). */
export async function PUT() {
  const u = await staff();
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: "Backend not configured" }, { status: 503 });
  const { data: existing } = await db.from("eval_suites").select("id").eq("name", "default-support-safety").limit(1);
  if (existing?.length) return NextResponse.json({ seeded: false, suite: existing[0] });
  const { data, error } = await db.from("eval_suites").insert({
    name: "default-support-safety", agent_id: "support.public", scenarios: DEFAULT_SCENARIOS,
  }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ seeded: true, suite: data }, { status: 201 });
}
