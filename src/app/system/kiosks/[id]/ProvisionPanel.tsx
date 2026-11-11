"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type TokenState = { state: "none" | "issued" | "expired" | "used"; expiresAt?: string | null };

/**
 * Provisioning token panel. Issue returns the raw token ONCE — it lives only in
 * component state, is never persisted client-side, and is cleared on refresh.
 */
export function ProvisionPanel({ deviceId, canManage, tokenState }: { deviceId: string; canManage: boolean; tokenState: TokenState }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ token: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const call = async (path: string, key: string) => {
    setBusy(key); setError(null);
    try {
      const res = await fetch(path, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError((j as { error?: string }).error ?? `HTTP ${res.status}`); return; }
      if (key === "issue") {
        const d = j as { token?: string; expires_at?: string };
        if (d.token) setIssued({ token: d.token, expiresAt: d.expires_at ?? "" });
      }
      router.refresh();
    } finally { setBusy(null); }
  };

  const copy = async () => {
    if (!issued) return;
    try { await navigator.clipboard.writeText(issued.token); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  };

  if (!canManage) {
    return <p className="text-xs text-slate-500">Requires system.kiosks.manage to issue/revoke tokens.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy !== null} onClick={() => call(`/api/system/kiosks/${deviceId}/provision`, "issue")}
          className="rounded-full bg-lime px-3 py-1.5 font-mono text-[11px] font-extrabold text-ink hover:bg-[#e6ffa8] disabled:opacity-50">
          {busy === "issue" ? "Issuing…" : "Issue provisioning token"}
        </button>
        {(tokenState.state === "issued" || tokenState.state === "expired") && (
          <button type="button" disabled={busy !== null} onClick={() => call(`/api/system/kiosks/${deviceId}/provision/revoke`, "revoke")}
            className="rounded-full bg-red-500/15 px-3 py-1.5 font-mono text-[11px] font-extrabold text-red-300 ring-1 ring-red-400/30 hover:bg-red-500/25 disabled:opacity-50">
            {busy === "revoke" ? "Revoking…" : "Revoke token"}
          </button>
        )}
        {error && <span className="font-mono text-[10px] text-red-300">{error}</span>}
      </div>

      {issued && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4">
          <p className="text-xs font-bold text-amber-300">⚠ Token shown once — copy it now. It is never stored or displayed again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-black/40 px-3 py-2 font-mono text-xs text-lime">{issued.token}</code>
            <button type="button" onClick={copy} className="shrink-0 rounded-full bg-white/10 px-3 py-1.5 font-mono text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
              {copied ? "copied" : "copy"}
            </button>
          </div>
          <p className="mt-2 font-mono text-[10px] text-amber-200/70">expires: {issued.expiresAt || "72h from issue"} · single-use · hash-only storage</p>
        </div>
      )}
      <p className="text-[10px] text-slate-500">
        Note: device ingest (<code className="font-mono">/api/devices/events</code>) still authenticates with the shared{" "}
        <code className="font-mono">KIOSK_INGEST_SECRET</code>; per-device token verification at ingest is a follow-up.
      </p>
    </div>
  );
}
