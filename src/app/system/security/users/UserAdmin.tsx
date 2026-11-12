"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

// Duplicated from src/lib/system/rbac.ts SYSTEM_ROLES — that module is server-only
// (imports next/headers via lib/auth) and must not enter the client bundle.
const SYSTEM_ROLES = ["viewer", "developer", "hardware", "engineer", "security", "sysadmin", "breakglass"] as const;

/**
 * Grant/revoke system_role + lifecycle controls (suspend / revoke sessions).
 * The API enforces: self-modification ban, breakglass+sysadmin grants need an
 * approved change request, privileged ops need a live step-up elevation
 * (403 {code:'step_up_required'} → prompt to verify MFA first).
 */
export function UserAdmin({ userId, currentRole, suspended, canManage }: {
  userId: string; currentRole: string | null; suspended: boolean; canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [grantRole, setGrantRole] = useState("");

  if (!canManage) {
    return <span className="font-mono text-[11px] text-slate-400">{currentRole ?? "—"}{suspended ? " · suspended" : ""}</span>;
  }

  const call = async (method: "POST" | "DELETE", body: Record<string, unknown>) => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/system/security/users", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({})) as { error?: string; message?: string; status?: string; code?: string };
      if (res.status === 202 || j.status === "pending") {
        setMsg("⏳ change request created — awaiting approval");
      } else if (j.code === "step_up_required" || res.status === 403) {
        setMsg(`🔒 ${j.error ?? "step-up required"} — verify MFA at /system/security/mfa first`);
      } else if (!res.ok) {
        setMsg(`✗ ${j.error ?? `HTTP ${res.status}`}`);
      } else {
        setMsg("✓ applied");
        setGrantRole("");
      }
      router.refresh();
    } finally { setBusy(false); }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="font-mono text-[11px] text-slate-300">
        {currentRole ?? "none"}
        {suspended && <span className="ml-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-bold text-red-300 ring-1 ring-red-400/30">suspended</span>}
      </span>
      <select
        value={grantRole}
        onChange={(e) => setGrantRole(e.target.value)}
        className="rounded-lg border border-white/15 bg-black/30 px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-lime/50"
      >
        <option value="">grant…</option>
        {SYSTEM_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      <button
        type="button"
        disabled={busy || !grantRole}
        onClick={() => call("POST", { user_id: userId, system_role: grantRole })}
        className="rounded-full bg-lime px-3 py-1 font-mono text-[11px] font-bold text-ink disabled:opacity-40"
      >
        grant
      </button>
      {currentRole && (
        <button
          type="button"
          disabled={busy}
          onClick={() => call("DELETE", { user_id: userId })}
          className="rounded-full bg-red-500/15 px-3 py-1 font-mono text-[11px] font-bold text-red-300 ring-1 ring-red-400/30 hover:bg-red-500/25 disabled:opacity-40"
        >
          revoke
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => call("POST", { action: suspended ? "unsuspend" : "suspend", user_id: userId })}
        className="rounded-full bg-white/10 px-3 py-1 font-mono text-[11px] font-bold text-slate-300 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-40"
      >
        {suspended ? "unsuspend" : "suspend"}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (window.confirm("Revoke ALL auth_sessions for this user? They will be signed out on next request.")) {
            void call("POST", { action: "revoke_sessions", user_id: userId });
          }
        }}
        className="rounded-full bg-white/10 px-3 py-1 font-mono text-[11px] font-bold text-slate-300 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-40"
      >
        kill sessions
      </button>
      {msg && <span className="w-full font-mono text-[10px] text-amber-300">{msg}</span>}
    </span>
  );
}
