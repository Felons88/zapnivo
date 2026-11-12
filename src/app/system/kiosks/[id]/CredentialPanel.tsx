"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type CredentialState =
  | { state: "none" }
  | { state: "pending"; authMethod: string }
  | {
      state: "active" | "expired" | "revoked";
      authMethod: string;
      issuedAt: string | null;
      expiresAt: string | null;
      revokedAt: string | null;
      lastAuthedAt: string | null;
      rotationPending?: boolean;
      rotationOverdue?: boolean;
      rotationAgeHours?: number;
      rotationNextExpiresAt?: string | null;
    };

type KekInfo = { configured: boolean; current_version: string; previous_configured: boolean };

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

/**
 * Per-device ingest credential panel. Issue returns the raw secret ONCE — it
 * lives only in component state and is cleared on refresh. The device uses
 * hex(sha256(secret)) as the HMAC-SHA256 signing key over
 * `${X-Device-Timestamp}.${rawBody}` (see src/lib/system/device-auth.ts).
 *
 * "Rotate (zero-downtime)" stages a new secret alongside the live one — the
 * device keeps working on the old secret until it authenticates once with the
 * new one (72h window), then promotion is automatic. Requires a step-up MFA
 * elevation; a 403 step_up_required surfaces its message here.
 */
export function CredentialPanel({ deviceId, canManage, credential, kek }: { deviceId: string; canManage: boolean; credential: CredentialState; kek?: KekInfo }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ secret: string; expiresAt: string; rotation?: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  const call = async (path: string, key: string, opts: { rotation?: boolean } = {}) => {
    setBusy(key); setError(null);
    try {
      const res = await fetch(path, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const e = j as { error?: string; code?: string };
        setError(e.code === "step_up_required" ? `Step-up required: ${e.error ?? "verify MFA first"}` : (e.error ?? `HTTP ${res.status}`));
        return;
      }
      if (key === "issue" || key === "rotate") {
        const d = j as { secret?: string; expires_at?: string; next_expires_at?: string };
        if (d.secret) setIssued({ secret: d.secret, expiresAt: d.expires_at ?? d.next_expires_at ?? "", rotation: key === "rotate" });
      }
      router.refresh();
    } finally { setBusy(null); }
  };

  const copy = async () => {
    if (!issued) return;
    try { await navigator.clipboard.writeText(issued.secret); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  };

  const active = credential.state === "active";
  const rotationPending = "rotationPending" in credential && credential.rotationPending === true;
  const rotationOverdue = "rotationOverdue" in credential && credential.rotationOverdue === true;
  const rotationAgeHours = "rotationAgeHours" in credential ? credential.rotationAgeHours : 0;
  const nextExpires = "rotationNextExpiresAt" in credential ? credential.rotationNextExpiresAt : null;

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        <div className="flex justify-between gap-2 border-b border-white/5 py-1"><dt className="text-slate-500">state</dt><dd className="font-mono text-slate-200">{credential.state}</dd></div>
        {"authMethod" in credential && <div className="flex justify-between gap-2 border-b border-white/5 py-1"><dt className="text-slate-500">auth_method</dt><dd className="font-mono text-slate-200">{credential.authMethod}</dd></div>}
        {"issuedAt" in credential && <div className="flex justify-between gap-2 border-b border-white/5 py-1"><dt className="text-slate-500">issued</dt><dd className="font-mono text-slate-200">{when(credential.issuedAt)}</dd></div>}
        {"expiresAt" in credential && <div className="flex justify-between gap-2 border-b border-white/5 py-1"><dt className="text-slate-500">expires</dt><dd className="font-mono text-slate-200">{when(credential.expiresAt)}</dd></div>}
        {"lastAuthedAt" in credential && <div className="flex justify-between gap-2 border-b border-white/5 py-1"><dt className="text-slate-500">last authed</dt><dd className="font-mono text-slate-200">{when(credential.lastAuthedAt)}</dd></div>}
        {rotationPending && (
          <div className="col-span-2 flex justify-between gap-2 border-b border-amber-400/20 bg-amber-400/5 px-2 py-1">
            <dt className="text-amber-300/80">rotation</dt>
            <dd className="font-mono text-amber-300">pending — next expires {when(nextExpires)}{rotationAgeHours ? ` · ${rotationAgeHours}h old` : ""}</dd>
          </div>
        )}
        {rotationOverdue && (
          <div className="col-span-2 flex justify-between gap-2 border-b border-red-400/30 bg-red-500/10 px-2 py-1">
            <dt className="text-red-300/90">rotation</dt>
            <dd className="font-mono text-red-300">OVERDUE — staged credential expired {when(nextExpires)}{rotationAgeHours ? ` · ${rotationAgeHours}h old` : ""}; awaiting sweep</dd>
          </div>
        )}
      </dl>

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy !== null} onClick={() => call(`/api/system/kiosks/${deviceId}/credential`, "issue")}
            className="rounded-full bg-lime px-3 py-1.5 font-mono text-[11px] font-extrabold text-ink hover:bg-[#e6ffa8] disabled:opacity-50">
            {busy === "issue" ? "Issuing…" : credential.state === "none" || credential.state === "pending" ? "Issue credential" : "Reissue (breaks old secret)"}
          </button>
          {active && !rotationPending && (
            <button type="button" disabled={busy !== null} onClick={() => call(`/api/system/kiosks/${deviceId}/credential/rotate`, "rotate")}
              className="rounded-full bg-sky-400/15 px-3 py-1.5 font-mono text-[11px] font-extrabold text-sky-300 ring-1 ring-sky-400/30 hover:bg-sky-400/25 disabled:opacity-50">
              {busy === "rotate" ? "Starting…" : "Rotate (zero-downtime)"}
            </button>
          )}
          {rotationPending && (
            <button type="button" disabled={busy !== null} onClick={() => call(`/api/system/kiosks/${deviceId}/credential/rotate/cancel`, "cancel")}
              className="rounded-full bg-white/10 px-3 py-1.5 font-mono text-[11px] font-extrabold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50">
              {busy === "cancel" ? "Cancelling…" : "Cancel rotation"}
            </button>
          )}
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
          <p className="text-xs font-bold text-amber-300">
            ⚠ Secret shown once — copy it now. Only its encrypted form is stored.{issued.rotation ? " Zero-downtime: the old secret keeps working until the device authenticates with this one." : ""}
          </p>
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

      {kek && (
        <p className="font-mono text-[10px] text-slate-500">
          KEK {kek.configured ? `v${kek.current_version}` : "NOT CONFIGURED"}
          {kek.previous_configured ? " · previous KEK staged (reencrypt pending)" : ""}
          {" — rotation: set DEVICE_CREDENTIAL_KEK_PREVIOUS=<old>, DEVICE_CREDENTIAL_KEK=<new>, run credential/reencrypt per device, then unset previous."}
        </p>
      )}

      <p className="text-[10px] text-slate-500">
        Ingest auth: <code className="font-mono">POST /api/devices/events</code> accepts this credential via HMAC headers, or the
        legacy shared secret only while <code className="font-mono">KIOSK_LEGACY_INGEST=1</code> (and only for stations without a
        live hmac credential). Attempts are logged in <code className="font-mono">system_device_messages</code>.
      </p>
    </div>
  );
}
