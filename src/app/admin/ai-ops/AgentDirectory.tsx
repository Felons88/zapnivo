"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Pill } from "@/components/SupportNav";
import type { DirectoryAgent } from "./page";

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never";

async function post(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.ok;
}

function AgentRow({ agent }: { agent: DirectoryAgent }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const s = agent.stats;

  const act = async (key: string, fn: () => Promise<boolean>) => {
    setBusy(key); setMsg(null);
    const ok = await fn();
    setMsg(ok ? "Done." : "Failed — check the API response.");
    setBusy(null);
    router.refresh();
  };

  return (
    <>
      <tr className="border-b border-mist/70 align-top hover:bg-lime/10">
        <td className="px-4 py-3">
          <p className="font-bold">{agent.name}</p>
          <p className="text-xs text-graphite">{agent.id} · {agent.department}</p>
          {typeof agent.config?.kill_reason === "string" && <p className="mt-1 text-xs font-semibold text-red-800">Killed: {String(agent.config.kill_reason).slice(0, 120)}</p>}
        </td>
        <td className="px-4 py-3 text-xs">{agent.model}<br /><span className="text-graphite">T={agent.temperature} · {agent.max_tokens} tok</span></td>
        <td className="px-4 py-3"><Pill tone={agent.enabled ? "lime" : "red"}>{agent.enabled ? "enabled" : "disabled"}</Pill></td>
        <td className="px-4 py-3 text-xs">{agent.max_calls_per_hour}/hr</td>
        <td className="px-4 py-3 text-xs">
          {agent.daily_budget_cents > 0 ? `$${(agent.daily_budget_cents / 100).toFixed(2)}/d` : "daily —"}
          <br />{agent.monthly_budget_cents > 0 ? `$${(agent.monthly_budget_cents / 100).toFixed(2)}/mo` : "monthly —"}
        </td>
        <td className="px-4 py-3 text-xs text-graphite">{when(s?.lastRunAt)}<br />{s ? `${s.runs} runs · ${s.errorRate}% err` : "no runs"}</td>
        <td className="px-4 py-3">
          <div className="flex flex-wrap gap-1">
            <button
              className="min-h-8 rounded-full bg-mist px-2.5 text-[11px] font-bold disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => act("ping", () => post(`/api/admin/ai/agents/${encodeURIComponent(agent.id)}/run`, { task: "control-center ping" }))}
            >{busy === "ping" ? "…" : "Ping"}</button>
            {agent.enabled ? (
              <button
                className="min-h-8 rounded-full bg-red-100 px-2.5 text-[11px] font-bold text-red-900 disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => { const reason = window.prompt("Kill reason (optional):") ?? ""; void act("kill", () => post(`/api/admin/ai/agents/${encodeURIComponent(agent.id)}/kill`, { reason })); }}
              >Kill</button>
            ) : (
              <button
                className="min-h-8 rounded-full bg-lime px-2.5 text-[11px] font-bold disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => act("enable", () => post(`/api/admin/ai/agents/${encodeURIComponent(agent.id)}/enable`))}
              >Enable</button>
            )}
          </div>
          {msg && <p className="mt-1 text-[11px] text-graphite">{msg}</p>}
        </td>
      </tr>
      <tr className="border-b border-mist/70 bg-mist/20">
        <td colSpan={7} className="px-4 py-3">
          <details>
            <summary className="cursor-pointer text-xs font-bold text-forest">Configure {agent.id}</summary>
            <AgentEditForm agent={agent} />
          </details>
        </td>
      </tr>
    </>
  );
}

function AgentEditForm({ agent }: { agent: DirectoryAgent }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num = (k: string) => Number(f.get(k));
    const patch = {
      model: String(f.get("model") ?? ""),
      temperature: num("temperature"),
      max_tokens: num("max_tokens"),
      timeout_ms: num("timeout_ms"),
      max_calls_per_hour: num("max_calls_per_hour"),
      daily_budget_cents: num("daily_budget_cents"),
      monthly_budget_cents: num("monthly_budget_cents"),
      escalation_policy: String(f.get("escalation_policy") ?? "") || null,
      permissions: String(f.get("permissions") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      tools: String(f.get("tools") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    };
    setState("saving"); setErr("");
    const res = await fetch(`/api/admin/ai/agents/${encodeURIComponent(agent.id)}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
    });
    if (res.ok) { setState("saved"); router.refresh(); }
    else { setState("error"); setErr((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`); }
  };

  const field = "min-h-9 w-full rounded-lg border border-silver/60 px-2 text-xs";
  return (
    <form onSubmit={submit} className="mt-3 grid gap-3 rounded-xl border border-mist bg-white p-4 sm:grid-cols-3">
      <label className="text-xs font-bold">Model<input name="model" defaultValue={agent.model} className={`mt-1 ${field}`} /></label>
      <label className="text-xs font-bold">Temperature<input name="temperature" type="number" step="0.05" min="0" max="2" defaultValue={agent.temperature} className={`mt-1 ${field}`} /></label>
      <label className="text-xs font-bold">Max tokens<input name="max_tokens" type="number" min="1" defaultValue={agent.max_tokens} className={`mt-1 ${field}`} /></label>
      <label className="text-xs font-bold">Timeout (ms)<input name="timeout_ms" type="number" min="500" defaultValue={agent.timeout_ms} className={`mt-1 ${field}`} /></label>
      <label className="text-xs font-bold">Calls / hour<input name="max_calls_per_hour" type="number" min="1" defaultValue={agent.max_calls_per_hour} className={`mt-1 ${field}`} /></label>
      <label className="text-xs font-bold">Daily budget (¢)<input name="daily_budget_cents" type="number" min="0" defaultValue={agent.daily_budget_cents} className={`mt-1 ${field}`} /></label>
      <label className="text-xs font-bold">Monthly budget (¢)<input name="monthly_budget_cents" type="number" min="0" defaultValue={agent.monthly_budget_cents} className={`mt-1 ${field}`} /></label>
      <label className="text-xs font-bold">Escalation policy<input name="escalation_policy" defaultValue={agent.escalation_policy ?? ""} placeholder="needs_human | staff_review" className={`mt-1 ${field}`} /></label>
      <label className="text-xs font-bold sm:col-span-2">Permissions (comma-separated)<input name="permissions" defaultValue={agent.permissions.join(", ")} className={`mt-1 ${field}`} /></label>
      <label className="text-xs font-bold sm:col-span-3">Tools (comma-separated allowlist)<input name="tools" defaultValue={agent.tools.join(", ")} className={`mt-1 ${field}`} /></label>
      <div className="flex items-center gap-3 sm:col-span-3">
        <button className="min-h-9 rounded-full bg-lime px-4 text-xs font-bold disabled:opacity-50" disabled={state === "saving"}>
          {state === "saving" ? "Saving…" : "Save agent config"}
        </button>
        {state === "saved" && <span className="text-xs font-bold text-forest">Saved.</span>}
        {state === "error" && <span className="text-xs font-bold text-red-800">{err}</span>}
      </div>
    </form>
  );
}

export function AgentDirectory({ agents }: { agents: DirectoryAgent[] }) {
  if (!agents.length) return <EmptyNote />;
  return (
    <div className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
      <table className="w-full min-w-[1100px] text-left text-sm">
        <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
          <tr>{["Agent", "Model", "State", "Calls/hr", "Budgets", "Last run / 30d", "Actions"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
        </thead>
        <tbody>
          {agents.map((a) => <AgentRow key={a.id} agent={a} />)}
        </tbody>
      </table>
    </div>
  );
}

function EmptyNote() {
  return <p className="rounded-2xl border border-mist bg-white px-6 py-10 text-sm text-graphite shadow-sm">No agents registered yet — the seed runs automatically on first load.</p>;
}
