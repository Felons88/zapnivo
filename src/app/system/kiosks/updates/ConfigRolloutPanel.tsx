import type { SupabaseClient } from "@supabase/supabase-js";
import {
  listConfigReleases, listConfigRolloutTargets,
  type ConfigRolloutTargetView, type UpdateReleaseRow,
} from "@/lib/system/update-config";
import { getGatewayAdapter, isGatewayUpdateCapable, updateCapabilitiesOf } from "@/lib/kiosk/gateway-adapter";
import ConfigRolloutForm from "./ConfigRolloutForm";

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

const stateTone = (s: string) =>
  s === "completed" ? "bg-lime/15 text-lime ring-lime/30"
  : s === "failed" || s === "cancelled" ? "bg-red-500/15 text-red-300 ring-red-400/30"
  : s === "verifying" ? "bg-violet-400/15 text-violet-300 ring-violet-400/30"
  : "bg-sky-400/15 text-sky-300 ring-sky-400/30";

function ReleaseRow({ r }: { r: UpdateReleaseRow }) {
  return (
    <tr className="border-t border-white/5 align-top">
      <td className="py-2 pr-3 font-mono text-[11px] font-bold text-slate-200">{r.version}</td>
      <td className="py-2 pr-3 text-[11px] text-slate-400">{r.channel}</td>
      <td className="py-2 pr-3"><span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-bold text-slate-300 ring-1 ring-white/10">{r.status}</span></td>
      <td className="py-2 pr-3"><span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-bold text-slate-400 ring-1 ring-white/10">{r.signature_status}</span></td>
      <td className="whitespace-nowrap py-2 pr-3 font-mono text-[10px] text-slate-500">{when(r.created_at)}</td>
    </tr>
  );
}

function TargetRow({ v }: { v: ConfigRolloutTargetView }) {
  const rev = v.revision;
  return (
    <tr className="border-t border-white/5 align-top">
      <td className="py-2 pr-3 font-mono text-[11px] text-slate-200">{v.device?.device_uid ?? v.target.device_id.slice(0, 8)}</td>
      <td className="py-2 pr-3 font-mono text-[10px] text-slate-400">{v.release ? `${v.release.version} (${v.release.channel})` : v.campaign?.name ?? "—"}</td>
      <td className="py-2 pr-3"><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${stateTone(v.target.state)}`}>{v.target.state}</span></td>
      <td className="max-w-[200px] truncate py-2 pr-3 font-mono text-[10px] text-slate-400" title={rev ? JSON.stringify(rev.desired) : ""}>
        {rev ? JSON.stringify(rev.desired) : "—"}
      </td>
      <td className="max-w-[200px] truncate py-2 pr-3 font-mono text-[10px] text-slate-500" title={rev?.reported ? JSON.stringify(rev.reported) : ""}>
        {rev?.reported ? JSON.stringify(rev.reported) : rev ? "no report" : "—"}
      </td>
      <td className="whitespace-nowrap py-2 pr-3 font-mono text-[10px] text-slate-500">{when(v.target.state_entered_at)}</td>
    </tr>
  );
}

/**
 * Config rollout panel (Phase 4.3). Server component — queries config-kind
 * kiosk_update_releases + recent kiosk_update_targets joined to their linked
 * device_config_revisions. Execution stays disabled while no certified
 * gateway adapter exists; the banner states the resolved KIOSK_ADAPTER
 * verbatim. db=null renders an honest empty state.
 */
export default async function ConfigRolloutPanel({ db, canManage }: { db: SupabaseClient | null; canManage: boolean }) {
  if (!db) {
    return (
      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
        <p className="eyebrow text-slate-500">Config rollouts</p>
        <p className="mt-2 text-sm text-slate-400">Backend not configured — config rollout data is unavailable.</p>
      </section>
    );
  }

  const adapter = getGatewayAdapter();
  const adapterName = process.env.KIOSK_ADAPTER?.trim() || "none";
  const updateCapable = isGatewayUpdateCapable(adapter);
  const updateCaps = updateCapabilitiesOf(adapter);
  const executionDisabled = !updateCaps.configUpdatePush;

  const [releases, targets] = await Promise.all([
    listConfigReleases(db, 50),
    listConfigRolloutTargets(db, { limit: 50 }),
  ]);

  return (
    <section className="space-y-4 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
      <div>
        <p className="eyebrow text-lime">Config rollouts</p>
        <h2 className="mt-1 font-display text-xl font-bold tracking-tight">Desired-state config across the fleet</h2>
        <p className="mt-1 max-w-3xl text-xs text-slate-400">
          Config-kind releases roll out through <code className="font-mono">device_config_revisions</code>.
          When a campaign exists for the release, per-device{" "}
          <code className="font-mono">kiosk_update_targets</code> rows track the update state machine;
          a target only reaches <em>completed</em> when the device reports matching config
          (revision <em>applied</em>). No reported-config channel exists in ingest today.
        </p>
      </div>

      {executionDisabled && (
        <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 font-mono text-[11px] text-amber-200">
          execution disabled: KIOSK_ADAPTER={adapterName} — adapter &quot;{adapter.name}&quot; reports{" "}
          configUpdatePush={String(updateCaps.configUpdatePush)}. Rollouts can be proposed and approved,
          but dispatch records honest adapter_disabled failures; nothing is sent to hardware.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <p className="mb-2 font-mono text-[10px] font-extrabold uppercase tracking-wider text-slate-500">
            Config releases ({releases.length})
          </p>
          {releases.length === 0 ? (
            <p className="text-xs text-slate-500">No kind=config releases yet — create one in Releases above, or propose a standalone rollout below.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>{["Version", "Channel", "Status", "Signature", "Created"].map((h) => <th key={h} className="pb-2 pr-3 font-extrabold">{h}</th>)}
                  </tr>
                </thead>
                <tbody>{releases.map((r) => <ReleaseRow key={r.id} r={r} />)}</tbody>
              </table>
            </div>
          )}
        </div>

        <ConfigRolloutForm releases={releases.map((r) => ({ id: r.id, label: `${r.version} · ${r.channel} · ${r.status}` }))} canManage={canManage} />
      </div>

      <div>
        <p className="mb-2 font-mono text-[10px] font-extrabold uppercase tracking-wider text-slate-500">
          Recent rollout targets ({targets.length})
        </p>
        {targets.length === 0 ? (
          <p className="text-xs text-slate-500">No kiosk_update_targets rows yet — targets require a campaign on the release.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["Device", "Release / campaign", "State", "Desired", "Reported", "Entered"].map((h) => <th key={h} className="pb-2 pr-3 font-extrabold">{h}</th>)}
                </tr>
              </thead>
              <tbody>{targets.map((v) => <TargetRow key={v.target.id} v={v} />)}</tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[10px] text-slate-500">
          State derives only from the linked device_config_revisions row: applied→completed,
          awaiting_report→verifying, failed→failed, superseded→cancelled. Standalone rollouts
          (no campaign) create revisions only and do not appear here.
        </p>
      </div>

      {updateCapable && (
        <p className="font-mono text-[10px] text-slate-500">
          update capabilities: {Object.entries(updateCaps).map(([k, v]) => `${k}=${v}`).join(" ")}
        </p>
      )}
    </section>
  );
}
