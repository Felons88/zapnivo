import type { SupabaseClient } from "@supabase/supabase-js";
import { listUpdateTargets, type UpdateTargetWithMeta } from "@/lib/system/update-rollouts";

/**
 * Per-device update targets panel — server component over
 * kiosk_update_targets. Shows the honest state machine position, attempt
 * count, last error and expandable result evidence (sanitized: secret-ish
 * keys stripped before render). Empty state when no targets exist.
 */

const STATE_TONE: Record<string, string> = {
  draft: "bg-white/10 text-slate-300 ring-white/15",
  approved: "bg-sky-400/15 text-sky-300 ring-sky-400/30",
  scheduled: "bg-violet-400/15 text-violet-300 ring-violet-400/30",
  queued: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  transferring: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  installing: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  reconnecting: "bg-cyan-400/15 text-cyan-300 ring-cyan-400/30",
  verifying: "bg-cyan-400/15 text-cyan-300 ring-cyan-400/30",
  completed: "bg-lime/15 text-lime ring-lime/30",
  failed: "bg-red-500/15 text-red-300 ring-red-400/30",
  unknown_outcome: "bg-red-500/25 text-red-200 ring-red-400/50",
  investigating: "bg-orange-500/15 text-orange-300 ring-orange-400/30",
  recovery: "bg-orange-500/15 text-orange-300 ring-orange-400/30",
  cancelled: "bg-white/5 text-slate-500 ring-white/10",
};

const SECRETISH_KEY = /pass|secret|token|credential|authorization|cookie|otp|card|cvv|ssn/i;

/** Deep-copies a result jsonb minus secret-ish keys (display sanitization). */
function sanitizeResult(result: Record<string, unknown> | null): unknown {
  if (result == null) return null;
  const clean = (v: unknown, depth: number): unknown => {
    if (depth > 4) return "[truncated]";
    if (Array.isArray(v)) return v.slice(0, 30).map((x) => clean(x, depth + 1));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 40)) {
        if (SECRETISH_KEY.test(k)) continue;
        out[k] = clean(val, depth + 1);
      }
      return out;
    }
    if (typeof v === "string" && v.length > 500) return `${v.slice(0, 500)}…`;
    return v;
  };
  return clean(result, 0);
}

function TargetRow({ t }: { t: UpdateTargetWithMeta }) {
  const evidence = sanitizeResult(t.result);
  return (
    <tr className="border-b border-white/5 align-top">
      <td className="py-2 pr-3">
        <div className="font-mono text-[11px] text-slate-200">{t.device_uid ?? t.device_id.slice(0, 8)}</div>
        {t.device_model && <div className="text-[10px] text-slate-500">{t.device_model}</div>}
      </td>
      <td className="py-2 pr-3 text-[11px] text-slate-400">{t.campaign_name ?? t.campaign_id.slice(0, 8)}</td>
      <td className="py-2 pr-3">
        <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${STATE_TONE[t.state] ?? STATE_TONE.draft}`}>
          {t.state}
        </span>
      </td>
      <td className="py-2 pr-3 font-mono text-[10px] text-slate-400">{t.attempt}</td>
      <td className="py-2 pr-3 text-[10px]">
        {t.last_error
          ? <span className="text-red-300/90">{t.last_error.slice(0, 120)}</span>
          : <span className="text-slate-600">—</span>}
      </td>
      <td className="py-2 pr-3 text-[10px] text-slate-500">{new Date(t.state_entered_at).toLocaleString()}</td>
      <td className="py-2">
        {evidence != null ? (
          <details className="max-w-md">
            <summary className="cursor-pointer font-mono text-[10px] text-slate-400 hover:text-slate-200">result jsonb</summary>
            <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[9px] leading-relaxed text-slate-400">
              {JSON.stringify(evidence, null, 2)}
            </pre>
          </details>
        ) : <span className="text-slate-600">—</span>}
      </td>
    </tr>
  );
}

export default async function UpdateTargetsPanel({ db }: { db: SupabaseClient | null }) {
  if (!db) {
    return (
      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
        <h2 className="eyebrow text-slate-400">Update targets</h2>
        <p className="mt-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          Backend not configured — per-device update state unavailable.
        </p>
      </section>
    );
  }

  const targets = await listUpdateTargets(db, { limit: 200 });

  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
      <h2 className="eyebrow text-slate-400">Update targets</h2>
      <p className="mt-1 max-w-3xl text-xs text-slate-400">
        Per-device state machine position. <code className="font-mono">queued</code> means the command is recorded —
        it is NOT proof of physical progress. <code className="font-mono">completed</code> requires device-reported
        version + fresh heartbeat verification. Rows marked <code className="font-mono">simulated</code> in result
        jsonb come from the dev simulator and are never real telemetry.
      </p>

      {targets.length === 0 ? (
        <p className="mt-4 rounded-xl border border-white/10 bg-black/20 px-4 py-6 text-center text-sm text-slate-400">
          No update targets yet — create and activate a campaign above.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-white/10 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                <th className="py-2 pr-3">Device</th>
                <th className="py-2 pr-3">Campaign</th>
                <th className="py-2 pr-3">State</th>
                <th className="py-2 pr-3">Attempt</th>
                <th className="py-2 pr-3">Last error</th>
                <th className="py-2 pr-3">Entered</th>
                <th className="py-2">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((t) => <TargetRow key={t.id} t={t} />)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
