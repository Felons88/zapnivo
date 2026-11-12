"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type CredentialState =
  | { state: "none" }
  | { state: "pending"; authMethod: string }
  | { state: "active" | "expired" | "revoked"; authMethod: string; issuedAt: string | null; expiresAt: string | null; revokedAt: string | null; lastAuthedAt: string | null };

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

/**
 * Per-device ingest credential panel. Issue returns the raw secret ONCE — it
 * lives only in component state and is cleared on refresh. The device uses
 * hex(sha256(secret)) as the HMAC-SHA256 signing key over
 * `${X-Device-Timestamp}.${rawBody}` (see src/lib/system/device-auth.ts).
 */
export function CredentialPanel({ deviceId, canManage, credential }: { deviceId: string; canManage: boolean; credential: CredentialState }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ secret: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const call = async (path: string, key: string) => {
    setBusy(key); setError(null);
    try {
      const res = await fetch(path, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError((j as { error?: string }).error ?? `HTTP ${res.status}`); return; }
      if (key === "issue") {
        const d = j as { secret?: string; expires_at?: string };
        if (d.secret) setIssued({ secret: d.secret, expiresAt: d.expires_at ?? "" });
      }
      router.refresh();
    } finally { setBusy(null); }
  };

  const copy = async () => {
    if (!issued) return;
    try { await navigator.clipboard.writeText(issued.secret); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  };

  const active = credential.state === "active";

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        <div className="flex justify-between gap-2 border-b border-white/5 py-1"><dt className="text-slate-500">state</dt><dd className="font-mono text-slate-200">{credential.state}</dd></div>
        {"authMethod" in credential && <div className="flex justify-between gap-2 border-b border-white/5 py-1"><dt className="text-slate-500">auth_method</dt><dd className="font-mono text-slate-200">{credential.authMethod}</dd></div>}
        {"issuedAt" in credential && <div className="flex justify-between gap-2 border-b border-white/5 py-1"><dt className="text-slate-500">issued</dt><dd className="font-mono text-slate-200">{when(credential.issuedAt)}</dd></div>}
        {"expiresAt" in credential && <div className="flex justify-between gap-2 border-b border-white/5 py-1"><dt className="text-slate-500">expires</dt><dd className="font-mono text-slate-200">{when(credential.expiresAt)}</dd></div>}
        {"lastAuthedAt" in credential && <div className="flex justify-between gap-2 border-b border-white/5 py-1"><dt className="text-slate-500">last authed</dt><dd className="font-mono text-slate-200">{when(credential.lastAuthedAt)}</dd></div>}
      </dl>

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy !== null} onClick={() => call(`/api/system/kiosks/${deviceId}/credential`, "issue")}
            className="rounded-full bg-lime px-3 py-1.5 font-mono text-[11px] font-extrabold text-ink hover:bg-[#e6ffa8] disabled:opacity-50">
            {busy === "issue" ? "Issuing…" : credential.state === "none" || credential.state === "pending" ? "Issue credential" : "Rotate credential"}
          </button>
          {(active || credential.state === "expired") && (
            <button type="button" disabled={busy !== null} onClick={() => call(`/api/system/kiosks/${deviceId}/credential/revoke`, "revoke")}
              className="rounded-full bg-red-500/15 px-3 py-1.5 font-mono text-[11px] font-extrabold text-red-300 ring-1 ring-red-400/30 hover:bg-red-500/25 disabled:opacity-50">
              {busy === "revoke" ? "Revoking…" : "Revoke credential"}
            </button>
          )}
          {error && <span className="font-mono text-[10px] text-red-300">{error}</span>}
        </div>
      ) : (
        <p className="text-xs text-slate-500">Requires system.kiosks.manage to issue/revoke credentials.</p>
      )}

      {issued && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4">
          <p className="text-xs font-bold text-amber-300">⚠ Secret shown once — copy it now. Only its SHA-256 hash is stored.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-black/40 px-3 py-2 font-mono text-xs text-lime">{issued.secret}</code>
            <button type="button" onClick={copy} className="shrink-0 rounded-full bg-white/10 px-3 py-1.5 font-mono text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
              {copied ? "copied" : "copy"}
            </button>
          </div>
          <p className="mt-2 font-mono text-[10px] text-amber-200/70">
            expires: {issued.expiresAt || "1y from issue"} · signing key = hex(sha256(secret)) · headers: X-Device-Id / X-Device-Timestamp / X-Device-Signature
          </p>
        </div>
      )}

      <p className="text-[10px] text-slate-500">
        Ingest auth: <code className="font-mono">POST /api/devices/events</code> accepts this credential via HMAC headers, or the
        legacy shared secret only while <code className="font-mono">KIOSK_LEGACY_INGEST=1</code> (and only for stations without a
        live hmac credential). Attempts are logged in <code className="font-mono">system_device_messages</code>.
      </p>
    </div>
  );
}
