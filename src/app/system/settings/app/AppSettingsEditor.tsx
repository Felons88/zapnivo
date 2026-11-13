"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AppSettingView } from "@/lib/system/app-settings";

/**
 * Editor for whitelisted app settings. Low-risk keys save directly; high-risk
 * keys surface the API's honest 403 step_up_required (verify MFA first) and
 * 202 pending (change request awaiting approval) states.
 */
export function AppSettingsEditor({
  settings,
  canManage,
  when,
}: {
  settings: AppSettingView[];
  canManage: boolean;
  when: (iso: string | null) => string;
}) {
  return (
    <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
      <table className="w-full min-w-[960px] text-left text-xs">
        <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
          <tr>{["Key", "Value", "Risk", "State", "Description", "Updated", "Actions"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {settings.map((s) => (
          <SettingRow key={s.key} setting={s} canManage={canManage} when={when} />
        ))}
      </tbody>
    </table>
    </section>
  );
}

function displayValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v === "" ? "(empty)" : v;
  return JSON.stringify(v);
}

function SettingRow({ setting, canManage, when }: { setting: AppSettingView; canManage: boolean; when: (iso: string | null) => string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const startEdit = () => {
    setDraft(setting.kind === "boolean" ? String(setting.value === true) : String(setting.value ?? ""));
    setEditing(true);
    setError(null);
    setNotice(null);
  };

  const save = async () => {
    const value = setting.kind === "boolean" ? draft === "true" : draft;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/system/settings/app", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: setting.key, value }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string; message?: string };
      if (res.status === 202) {
        setNotice(j.message ?? "Change request created — awaiting approval.");
        setEditing(false);
      } else if (!res.ok) {
        setError(
          j.code === "step_up_required"
            ? `Step-up required: ${j.error ?? "verify MFA first"} (/system/security/mfa)`
            : (j.error ?? `HTTP ${res.status}`),
        );
      } else {
        setEditing(false);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const highRisk = setting.risk === "high";
  return (
    <tr className="border-b border-white/5 align-top last:border-0">
      <td className="px-4 py-3">
        <div className="font-mono font-bold text-lime">{setting.key}</div>
        <div className="mt-0.5 font-mono text-[10px] text-slate-500">{setting.kind}</div>
      </td>
      <td className="max-w-[220px] px-4 py-3">
        {editing ? (
          setting.kind === "boolean" ? (
            <select
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="rounded-md border border-white/15 bg-black/40 px-2 py-1 font-mono text-xs text-slate-200"
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={500}
              className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1 font-mono text-xs text-slate-200"
            />
          )
        ) : (
          <code className="line-clamp-2 break-all text-[11px] text-slate-300">{displayValue(setting.value)}</code>
        )}
        {error && <div className="mt-1 font-mono text-[10px] text-red-300">{error}</div>}
        {notice && <div className="mt-1 font-mono text-[10px] text-amber-300">{notice}</div>}
      </td>
      <td className="px-4 py-3">
        <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${highRisk ? "bg-red-500/15 text-red-300 ring-red-400/30" : "bg-white/10 text-slate-300 ring-white/15"}`}>
          {setting.risk}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${setting.isDefault ? "bg-white/10 text-slate-400 ring-white/15" : "bg-lime/15 text-lime ring-lime/30"}`}>
          {setting.isDefault ? "default" : "set"}
        </span>
      </td>
      <td className="max-w-sm px-4 py-3 text-slate-400">{setting.description}</td>
      <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-slate-500">{when(setting.updatedAt)}</td>
      <td className="px-4 py-3">
        {canManage && !editing && (
          <button
            type="button"
            onClick={startEdit}
            className="rounded-full bg-white/10 px-3 py-1 font-mono text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/20"
          >
            edit{highRisk ? " (elevated)" : ""}
          </button>
        )}
        {canManage && editing && (
          <span className="inline-flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={save}
              className="rounded-full bg-lime/15 px-3 py-1 font-mono text-[11px] font-bold text-lime ring-1 ring-lime/30 hover:bg-lime/25 disabled:opacity-50"
            >
              {busy ? "…" : "save"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => { setEditing(false); setError(null); setNotice(null); }}
              className="rounded-full bg-white/10 px-3 py-1 font-mono text-[11px] font-bold text-slate-300 ring-1 ring-white/15 hover:bg-white/20 disabled:opacity-50"
            >
              cancel
            </button>
          </span>
        )}
      </td>
    </tr>
  );
}
