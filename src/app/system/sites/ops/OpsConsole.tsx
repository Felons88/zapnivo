"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type RedirectRow = {
  id: string; site_key: string; from_path: string; to_path: string;
  enabled: boolean; note: string | null; created_at: string;
};
type SiteOption = { key: string; label: string };
type Notice = { text: string; severity: string; expiresAt: string } | null;

/**
 * Site-ops console: maintenance notice (delegates to the emergency
 * maintenance_banner op server-side) + redirect rule CRUD. Every mutation
 * requires a reason (audited) and goes through /api/system/site-ops.
 */
export function OpsConsole({
  canManage,
  configured,
  notice,
  redirects,
  sites,
}: {
  canManage: boolean;
  configured: boolean;
  notice: Notice;
  redirects: RedirectRow[];
  sites: SiteOption[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"notice" | "redirects">("notice");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // notice form
  const [nOn, setNOn] = useState(true);
  const [nMessage, setNMessage] = useState("");
  const [nMinutes, setNMinutes] = useState(60);
  const [nSeverity, setNSeverity] = useState<"info" | "warning" | "critical">("info");

  // redirect form
  const [rSite, setRSite] = useState(sites[0]?.key ?? "apex");
  const [rFrom, setRFrom] = useState("");
  const [rTo, setRTo] = useState("");
  const [rNote, setRNote] = useState("");

  const [reason, setReason] = useState("");

  const post = async (payload: Record<string, unknown>) => {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/system/site-ops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, reason: reason.trim() }),
      });
      const j = await res.json().catch(() => ({})) as { error?: string; summary?: string; status?: string; code?: string };
      if (res.status === 202 || j.status === "pending") {
        setMsg({ ok: true, text: `⏳ ${j.summary ?? "change request created — awaiting approval"}` });
      } else if (res.status === 403 && j.code === "step_up_required") {
        setMsg({ ok: false, text: "🔒 Step-up verification required — complete MFA step-up under Security → MFA & step-up, then retry." });
      } else if (!res.ok) {
        setMsg({ ok: false, text: `✗ ${j.error ?? `HTTP ${res.status}`}` });
      } else {
        setMsg({ ok: true, text: `✓ ${j.summary ?? "done"}` });
        setRFrom(""); setRTo(""); setRNote(""); setNMessage("");
      }
      router.refresh();
    } finally { setBusy(false); }
  };

  const noticeReady = canManage && configured && reason.trim().length >= 10 && !busy && (!nOn || nMessage.trim().length >= 10);
  const redirectReady = canManage && configured && reason.trim().length >= 10 && !busy && Boolean(rFrom.trim() && rTo.trim());

  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
      <div className="flex items-center gap-1 border-b border-white/10 px-4 pt-3">
        {(["notice", "redirects"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => { setTab(t); setMsg(null); }}
            className={`rounded-t-lg px-4 py-2 text-xs font-bold ring-1 ring-b-0 ${tab === t ? "bg-white/[0.06] text-lime ring-white/10" : "text-slate-400 ring-transparent hover:text-slate-200"}`}
          >
            {t === "notice" ? "Maintenance notice" : `Redirects (${redirects.length})`}
          </button>
        ))}
      </div>

      <div className="space-y-4 p-5">
        {!configured && <p className="text-sm text-amber-300">Backend not configured — ops unavailable.</p>}
        {!canManage && (
          <p className="rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-200 ring-1 ring-amber-400/30">
            Your role can view this page but cannot mutate ops — requires <code className="font-mono">system.flags.manage</code>.
          </p>
        )}

        {tab === "notice" && (
          <div className="space-y-3">
            <p className="text-xs text-slate-400">
              Sets or clears the <code className="font-mono">maintenance.notice</code> flag (TTL-bounded). Delegates to the
              emergency op — requires step-up elevation and writes the same audit trail as /system/emergency.
              {notice && <> Currently active: <span className="text-amber-200">{notice.text}</span> (expires {new Date(notice.expiresAt).toLocaleString()}).</>}
            </p>
            <label className="flex items-center gap-2 text-xs font-bold text-slate-200">
              <input type="checkbox" checked={nOn} onChange={(e) => setNOn(e.target.checked)} />
              {nOn ? "Set notice" : "Clear notice"}
            </label>
            {nOn && (
              <div className="grid gap-3 md:grid-cols-3">
                <input value={nMessage} onChange={(e) => setNMessage(e.target.value)} placeholder="Notice text (10–280 chars)" className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-lime/50 md:col-span-2" />
                <div className="flex gap-2">
                  <input type="number" min={5} max={240} value={nMinutes} onChange={(e) => setNMinutes(Number(e.target.value))} className="w-24 rounded-lg border border-white/15 bg-black/30 px-2 py-2 font-mono text-xs text-slate-200 outline-none" title="TTL minutes" />
                  <select value={nSeverity} onChange={(e) => setNSeverity(e.target.value as typeof nSeverity)} className="rounded-lg border border-white/15 bg-black/30 px-2 py-2 font-mono text-xs text-slate-200 outline-none">
                    <option value="info">info</option><option value="warning">warning</option><option value="critical">critical</option>
                  </select>
                </div>
              </div>
            )}
            <button type="button" disabled={!noticeReady} onClick={() => post({ action: nOn ? "set_notice" : "clear_notice", message: nMessage, minutes: nMinutes, severity: nSeverity })} className="rounded-full bg-lime px-5 py-2 text-xs font-bold text-ink hover:bg-[#e6ffa8] disabled:opacity-40">
              {busy ? "Saving…" : nOn ? "Set maintenance notice" : "Clear maintenance notice"}
            </button>
          </div>
        )}

        {tab === "redirects" && (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-[180px_1fr_1fr]">
              <select value={rSite} onChange={(e) => setRSite(e.target.value)} className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 font-mono text-xs text-slate-200 outline-none">
                {sites.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
              <input value={rFrom} onChange={(e) => setRFrom(e.target.value)} placeholder="from_path e.g. /old-page" className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-lime/50" />
              <input value={rTo} onChange={(e) => setRTo(e.target.value)} placeholder="to_path e.g. /new-page or https://zapnivo.com/x" className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-lime/50" />
            </div>
            <input value={rNote} onChange={(e) => setRNote(e.target.value)} placeholder="Note (optional, audited)" className="w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-lime/50" />
            <p className="text-[10px] text-slate-500">
              to_path must be a relative path or a same-host Zapnivo https URL — external redirects are rejected server-side.
            </p>
            <button type="button" disabled={!redirectReady} onClick={() => post({ action: "create_redirect", site_key: rSite, from_path: rFrom, to_path: rTo, note: rNote })} className="rounded-full bg-lime px-5 py-2 text-xs font-bold text-ink hover:bg-[#e6ffa8] disabled:opacity-40">
              {busy ? "Saving…" : "Create redirect"}
            </button>

            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>{["Site", "From", "To", "State", "Note", ""].map((h) => <th key={h} className="px-3 py-2 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {redirects.map((r) => (
                    <tr key={r.id} className="border-b border-white/5 last:border-0">
                      <td className="px-3 py-2 font-mono text-[11px] text-slate-300">{r.site_key}</td>
                      <td className="px-3 py-2 font-mono text-[11px] text-slate-300">{r.from_path}</td>
                      <td className="max-w-[220px] truncate px-3 py-2 font-mono text-[11px] text-slate-400" title={r.to_path}>{r.to_path}</td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          disabled={!canManage || busy}
                          onClick={() => post({ action: "update_redirect", id: r.id, enabled: !r.enabled })}
                          className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${r.enabled ? "bg-lime/15 text-lime ring-lime/30" : "bg-white/10 text-slate-400 ring-white/15"}`}
                        >
                          {r.enabled ? "enabled" : "disabled"}
                        </button>
                      </td>
                      <td className="max-w-[140px] truncate px-3 py-2 text-[11px] text-slate-500" title={r.note ?? ""}>{r.note ?? "—"}</td>
                      <td className="px-3 py-2 text-right">
                        <button type="button" disabled={!canManage || busy} onClick={() => { if (confirm(`Delete redirect ${r.site_key}${r.from_path}?`)) post({ action: "delete_redirect", id: r.id }); }} className="font-mono text-[10px] font-bold text-red-300 hover:text-red-200 disabled:opacity-40">delete</button>
                      </td>
                    </tr>
                  ))}
                  {redirects.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">No redirect rules yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
          <label className="block">
            <span className="eyebrow text-slate-500">Reason (audited, min 10 chars)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="incident reference / justification" className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-lime/50" />
          </label>
        </div>
        {msg && <p className={`rounded-lg px-3 py-2 font-mono text-[11px] ring-1 ${msg.ok ? "bg-lime/10 text-lime ring-lime/30" : "bg-red-500/10 text-red-300 ring-red-400/30"}`}>{msg.text}</p>}
      </div>
    </section>
  );
}
