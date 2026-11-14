"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AssignableUser } from "@/lib/system/incidents";

/**
 * Incident assignee control. POSTs /api/system/incidents/{id}/assign with
 * { assignee_id } (null clears). Options are system users only — the server
 * re-validates system_role + suspension.
 */
export function IncidentAssign({
  incidentId,
  owner,
  users,
}: {
  incidentId: string;
  owner: string | null;
  users: AssignableUser[];
}) {
  const router = useRouter();
  const [value, setValue] = useState(owner ?? "");
  const [state, setState] = useState<"idle" | "loading" | "done" | string>("idle");

  const label = (id: string | null) => {
    if (!id) return "unassigned";
    const u = users.find((x) => x.id === id);
    return u ? (u.full_name ?? u.email ?? u.id.slice(0, 8)) : `${id.slice(0, 8)}…`;
  };

  async function submit(next: string) {
    setState("loading");
    try {
      const res = await fetch(`/api/system/incidents/${incidentId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignee_id: next === "" ? null : next }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
      if (res.ok) { setValue(next); setState("done"); router.refresh(); }
      else if (res.status === 202) setState("pending approval");
      else setState(json.reason ?? json.error ?? `HTTP ${res.status}`);
    } catch {
      setState("request failed");
    }
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={value}
        onChange={(e) => void submit(e.target.value)}
        disabled={state === "loading"}
        className="min-w-0 flex-1 rounded-lg border border-white/15 bg-black/40 px-2 py-1 font-mono text-[11px] text-slate-200"
        aria-label="Incident assignee"
      >
        <option value="">— unassigned —</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>{u.full_name ?? u.email ?? u.id.slice(0, 8)} · {u.system_role}</option>
        ))}
        {owner && !users.some((u) => u.id === owner) && (
          <option value={owner}>{label(owner)} (current)</option>
        )}
      </select>
      {state !== "idle" && state !== "done" && (
        <span className="font-mono text-[10px] text-amber-300">{String(state).slice(0, 24)}</span>
      )}
    </div>
  );
}
