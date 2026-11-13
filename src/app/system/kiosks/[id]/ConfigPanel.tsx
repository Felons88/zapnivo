"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export type ConfigRevision = {
  id: string; revision: number;
  desired: Record<string, unknown>; status: string;
  command_id: string | null; reported: Record<string, unknown> | null;
  actor: string | null; created_at: string;
};

const ALLOWED_KEYS = ["heartbeat_interval_sec", "maintenance_mode", "ad_playlist_id", "brightness", "config_notes"];
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z";

/**
 * Desired-state config panel. Actions map to POST /api/system/kiosks/[id]/config.
 * Dispatch with KIOSK_ADAPTER=none records the command failed/adapter_disabled —
 * the UI surfaces the honest revision status, never claims delivery.
 */
export function ConfigPanel({ deviceId, canManage, revisions }: { deviceId: string; canManage: boolean; revisions: ConfigRevision[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [desiredText, setDesiredText] = useState(
    JSON.stringify({ maintenance_mode: false, brightness: 80 }, null, 2),
  );

  const call = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setError(null); setNotice(null);
    try {
      const res = await fetch(`/api/system/kiosks/${deviceId}/config`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 202) {
        setNotice(`Change request ${(j as { changeRequestId?: string }).changeRequestId?.slice(0, 8) ?? ""} pending approval`);
      } else if (!res.ok) {
        setError((j as { error?: string }).error ?? `HTTP ${res.status}`);
      } else {
        const rev = (j as { revision?: ConfigRevision }).revision;
        if (rev) setNotice(`revision ${rev.revision} → ${rev.status}`);
      }
      router.refresh();
    } finally { setBusy(null); }
  };

  const propose = () => {
    let desired: unknown;
    try { desired = JSON.parse(desiredText); } catch { setError("desired is not valid JSON"); return; }
    void call("propose", { action: "propose", desired });
  };

  const statusTone = (s: string) =>
    s === "applied" ? "bg-lime/15 text-lime ring-lime/30"
    : s === "failed" ? "bg-red-500/15 text-red-300 ring-red-400/30"
    : s === "superseded" ? "bg-white/5 text-slate-500 ring-white/10"
    : "bg-sky-400/15 text-sky-300 ring-sky-400/30";

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="rounded-xl border border-white/[0.08] bg-black/20 p-3">
          <p className="mb-2 font-mono text-[10px] font-extrabold uppercase tracking-wider text-slate-500">
            Propose desired config — allowed keys: {ALLOWED_KEYS.join(", ")}
          </p>
          <textarea
            value={desiredText}
            onChange={(e) => setDesiredText(e.target.value)}
            rows={5}
            spellCheck={false}
            className="w-full rounded-lg border border-white/10 bg-black/40 p-2 font-mono text-[11px] text-slate-200"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={busy !== null} onClick={propose}
              className="rounded-full bg-lime px-3 py-1 text-[11px] font-extrabold text-ink hover:bg-[#e6ffa8] disabled:opacity-50">
              {busy === "propose" ? "…" : "Propose draft"}
            </button>
            <button type="button" disabled={busy !== null}
              onClick={() => void call("rollback", { action: "rollback" })}
              className="rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15 disabled:opacity-50">
              {busy === "rollback" ? "…" : "Rollback to previous applied"}
            </button>
          </div>
          <p className="mt-2 text-[10px] text-slate-500">
            Unknown keys are rejected. maintenance_mode is medium-risk (change-request gate for
            breakglass/high-risk actors). Dispatch records a config_update command — with
            KIOSK_ADAPTER=none it lands failed/adapter_disabled, honestly.
          </p>
        </div>
      )}

      {error && <p className="font-mono text-[11px] text-red-300">{error}</p>}
      {notice && <p className="font-mono text-[11px] text-lime">{notice}</p>}

      {revisions.length === 0 ? (
        <p className="text-sm text-slate-400">No config revisions yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-slate-500">
              <tr>{["Rev", "Status", "Desired", "Reported", "Command", "When", ""].map((h) => <th key={h} className="pb-2 pr-3 font-extrabold">{h}</th>)}
            </tr>
          </thead>
          <tbody className="font-mono">
            {revisions.map((r) => (
              <tr key={r.id} className="border-t border-white/5 align-top">
                <td className="py-2 pr-3 font-bold text-slate-200">r{r.revision}</td>
                <td className="py-2 pr-3"><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${statusTone(r.status)}`}>{r.status}</span></td>
                <td className="max-w-[220px] truncate py-2 pr-3 text-[10px] text-slate-400" title={JSON.stringify(r.desired)}>{JSON.stringify(r.desired)}</td>
                <td className="max-w-[180px] truncate py-2 pr-3 text-[10px] text-slate-500" title={r.reported ? JSON.stringify(r.reported) : ""}>{r.reported ? JSON.stringify(r.reported) : "—"}</td>
                <td className="py-2 pr-3 text-[10px] text-slate-500">{r.command_id ? r.command_id.slice(0, 8) : "—"}</td>
                <td className="whitespace-nowrap py-2 pr-3 text-[10px] text-slate-500">{when(r.created_at)}</td>
                <td className="py-2">
                  {canManage && r.status === "draft" && (
                    <span className="inline-flex gap-1">
                      <button type="button" disabled={busy !== null} onClick={() => void call(`approve-${r.id}`, { action: "approve", revision_id: r.id })}
                        className="rounded-full bg-sky-400/15 px-2 py-0.5 text-[10px] font-bold text-sky-300 ring-1 ring-sky-400/30 hover:bg-sky-400/25 disabled:opacity-50">approve</button>
                    </span>
                  )}
                  {canManage && r.status === "approved" && (
                    <button type="button" disabled={busy !== null} onClick={() => void call(`dispatch-${r.id}`, { action: "dispatch", revision_id: r.id })}
                      className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold text-amber-300 ring-1 ring-amber-400/30 hover:bg-amber-400/25 disabled:opacity-50">dispatch</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
      <p className="text-[10px] text-slate-500">
        &apos;awaiting_report&apos; means a config_update command was queued but the device has not
        reported matching config — no reported-config channel exists in ingest today, so with
        adapter=none revisions land &apos;failed&apos; instead. reported stays null until one does.
      </p>
    </div>
  );
}
