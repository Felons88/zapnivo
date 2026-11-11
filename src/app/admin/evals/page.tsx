export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { serviceClient } from "@/lib/supabase";
import { EvalsClient } from "./EvalsClient";

export const metadata: Metadata = { title: "AI Evaluations", robots: { index: false, follow: false } };

export default async function EvalsPage() {
  const db = serviceClient();
  const [{ data: suites }, { data: runs }] = db
    ? await Promise.all([
        db.from("eval_suites").select("id,name,agent_id,active,created_at").order("created_at", { ascending: false }),
        db.from("eval_runs").select("id,suite_id,agent_id,score,passed,total,latency_ms,created_at").order("created_at", { ascending: false }).limit(30),
      ])
    : [{ data: [] }, { data: [] }] as const;

  return (
    <AdminGate title="Evaluations" nav="evals">
      <div className="space-y-6">
        <div>
          <p className="eyebrow">AI Operations</p>
          <h1 className="display-md mt-1">Evaluation lab</h1>
          <p className="lead mt-2">Synthetic scenarios only — never real customer conversations. Scores: accuracy, privacy, authorization, policy, escalation, usefulness.</p>
        </div>
        <EvalsClient suites={(suites ?? []) as never[]} runs={(runs ?? []) as never[]} />
      </div>
    </AdminGate>
  );
}
