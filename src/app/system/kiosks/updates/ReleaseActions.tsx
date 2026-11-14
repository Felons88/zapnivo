"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Action = "approve" | "deprecate" | "revoke";

const ACTION_LABEL: Record<Action, string> = { approve: "Approve", deprecate: "Deprecate", revoke: "Revoke" };

/**
 * Per-release lifecycle buttons. Allowed actions are computed server-side and
 * passed in — the API re-validates every transition. Approving firmware/
 * software may return 403 step_up_required (fresh MFA elevation needed);
 * that error is surfaced verbatim so the operator knows to re-verify.
 */
export function ReleaseActions({
  releaseId, kind, status, canManage,
}: { releaseId: string; kind: string; status: string; canManage: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  const actions: Action[] =
    status === "draft" ? ["approve", "revoke"]
    : status === "approved" ? ["deprecate", "revoke"]
    : [];

  if (!canManage || actions.length === 0) return null;

  const go = async (action: Action) => {
    const warn =
      action === "approve" && (kind === "firmware" || kind === "software")
        ? `Approve ${kind} release? Requires signature_status='verified' and a fresh MFA elevation.`
        : action === "revoke"
          ? `Revoke this ${status} release? This is terminal — the release can never be approved or used.`
          : `Deprecate this approved release? It stays visible but should no longer be rolled out.`;
    if (!window.confirm(warn)) return;
    setBusy(action); setError(null);
    try {
      const res = await fetch(`/api/system/updates/releases/${releaseId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok) {
        setError(j.code === "step_up_required" ? `Step-up required: ${j.error}` : (j.error ?? `HTTP ${res.status}`));
      }
      router.refresh();
    } finally { setBusy(null); }
  };

  const tone = (a: Action) =>
    a === "approve" ? "bg-lime/15 text-lime ring-lime/30 hover:bg-lime/25"
    : a === "deprecate" ? "bg-amber-400/15 text-amber-300 ring-amber-400/30 hover:bg-amber-400/25"
    : "bg-red-500/15 text-red-300 ring-red-400/30 hover:bg-red-500/25";

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {actions.map((a) => (
        <button key={a} type="button" disabled={busy !== null} onClick={() => go(a)}
          className={`rounded-full px-3 py-1 font-mono text-[11px] font-extrabold ring-1 disabled:opacity-50 ${tone(a)}`}>
          {busy === a ? "…" : ACTION_LABEL[a]}
        </button>
      ))}
      {error && <span className="font-mono text-[10px] text-red-300">{error}</span>}
    </span>
  );
}

const KINDS = ["firmware", "software", "config", "display_manifest"] as const;
const CHANNELS = ["canary", "beta", "stable"] as const;

/**
 * Minimal draft-registration form. Creates a metadata-only draft row via
 * POST /api/system/updates/releases. Artifact bytes are uploaded separately
 * to the private 'kiosk-updates' bucket, then coordinates are attached via
 * PATCH register_artifact — this form never handles file content.
 */
export function ReleaseDraftForm({ canManage }: { canManage: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    kind: "firmware", version: "", channel: "stable",
    manufacturer: "", model: "", hw_revision_min: "",
    sha256: "", storage_path: "", release_notes: "",
  });

  if (!canManage) return null;

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = {
        kind: form.kind, version: form.version.trim(), channel: form.channel,
      };
      for (const k of ["manufacturer", "model", "hw_revision_min", "sha256", "storage_path", "release_notes"] as const) {
        if (form[k].trim()) body[k] = form[k].trim();
      }
      const res = await fetch("/api/system/updates/releases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { setError(j.error ?? `HTTP ${res.status}`); return; }
      setForm({ kind: "firmware", version: "", channel: "stable", manufacturer: "", model: "", hw_revision_min: "", sha256: "", storage_path: "", release_notes: "" });
      setOpen(false);
      router.refresh();
    } finally { setBusy(false); }
  };

  const input = "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-lime/50 focus:outline-none";
  const label = "block text-[10px] font-extrabold uppercase tracking-wider text-slate-500";

  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="text-xs font-bold text-lime hover:underline">
        {open ? "− Cancel new draft" : "+ Register release draft"}
      </button>
      {open && (
        <form onSubmit={submit} className="mt-3 grid gap-3 md:grid-cols-3">
          <label className={label}>Kind
            <select value={form.kind} onChange={set("kind")} className={input}>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
          <label className={label}>Version *
            <input required value={form.version} onChange={set("version")} className={input} placeholder="e.g. 2.4.1" />
          </label>
          <label className={label}>Channel
            <select value={form.channel} onChange={set("channel")} className={input}>
              {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className={label}>Manufacturer
            <input value={form.manufacturer} onChange={set("manufacturer")} className={input} />
          </label>
          <label className={label}>Model
            <input value={form.model} onChange={set("model")} className={input} />
          </label>
          <label className={label}>Min HW revision
            <input value={form.hw_revision_min} onChange={set("hw_revision_min")} className={input} />
          </label>
          <label className={label}>SHA-256 (optional)
            <input value={form.sha256} onChange={set("sha256")} className={`${input} font-mono`} placeholder="64 lowercase hex" />
          </label>
          <label className={`${label} md:col-span-2`}>Storage path in kiosk-updates bucket (optional)
            <input value={form.storage_path} onChange={set("storage_path")} className={`${input} font-mono`} placeholder="releases/fw/2.4.1.bin" />
          </label>
          <label className={`${label} md:col-span-3`}>Release notes
            <textarea value={form.release_notes} onChange={set("release_notes")} rows={2} className={input} />
          </label>
          <div className="flex items-center gap-3 md:col-span-3">
            <button type="submit" disabled={busy}
              className="rounded-full bg-lime px-4 py-1.5 text-xs font-extrabold text-forest hover:brightness-110 disabled:opacity-50">
              {busy ? "Creating…" : "Create draft"}
            </button>
            {error && <span className="font-mono text-[11px] text-red-300">{error}</span>}
          </div>
        </form>
      )}
    </div>
  );
}
