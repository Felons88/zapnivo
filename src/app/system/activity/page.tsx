export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { listActivity, resourceHref, type ActivityRow } from "@/lib/system/activity";

export const metadata: Metadata = { title: "Activity — audit feed" };

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "UTC" }) + "Z";

const ROLE_TONE: Record<string, string> = {
  sysadmin: "text-lime", breakglass: "text-red-300", security: "text-amber-300",
  engineer: "text-sky-300", developer: "text-fuchsia-300", hardware: "text-cyan-300",
  viewer: "text-slate-300", system: "text-slate-500",
};

function Detail({ row }: { row: ActivityRow }) {
  const keys = Object.keys(row.detail ?? {});
  if (!keys.length) return <span className="text-slate-600">—</span>;
  return (
    <details className="group">
      <summary className="cursor-pointer font-mono text-[10px] text-slate-500 hover:text-slate-300">
        {keys.length} field{keys.length === 1 ? "" : "s"}
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-black/40 p-3 font-mono text-[10px] leading-relaxed text-slate-300 ring-1 ring-white/5">
        {JSON.stringify(row.detail, null, 2)}
      </pre>
    </details>
  );
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ actor?: string; role?: string; action?: string; resource?: string; from?: string; to?: string; cursor?: string }>;
}) {
  const sp = await searchParams;
  const db = serviceClient();
  const { rows, nextCursor, configured } = await listActivity(db, {
    actor: sp.actor, actorRole: sp.role, actionPrefix: sp.action,
    resourceType: sp.resource, from: sp.from, to: sp.to, cursor: sp.cursor,
  });

  const qs = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ actor: sp.actor, role: sp.role, action: sp.action, resource: sp.resource, from: sp.from, to: sp.to, ...extra })) {
      if (v) p.set(k, v);
    }
    const s = p.toString();
    return `/system/activity${s ? `?${s}` : ""}`;
  };

  const input = "rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:border-lime/40 focus:outline-none";

  return (
    <SystemGate perm="system.security.audit.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Security</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Activity</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Append-only audit stream — who did what, to which resource, when. Detail payloads are
            sanitized at write time (secrets are dropped before storage). Cursor-paginated, newest first.
          </p>
        </div>

        <form method="get" action="/system/activity" className="flex flex-wrap items-end gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.05] p-4">
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Actor id
            <input name="actor" defaultValue={sp.actor ?? ""} placeholder="uuid" className={`mt-1 block w-44 ${input}`} />
          </label>
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Role
            <input name="role" defaultValue={sp.role ?? ""} placeholder="sysadmin…" className={`mt-1 block w-32 ${input}`} />
          </label>
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Action prefix
            <input name="action" defaultValue={sp.action ?? ""} placeholder="change." className={`mt-1 block w-36 ${input}`} />
          </label>
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Resource type
            <input name="resource" defaultValue={sp.resource ?? ""} placeholder="device_command" className={`mt-1 block w-40 ${input}`} />
          </label>
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">From
            <input name="from" type="datetime-local" defaultValue={sp.from ?? ""} className={`mt-1 block ${input}`} />
          </label>
          <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500">To
            <input name="to" type="datetime-local" defaultValue={sp.to ?? ""} className={`mt-1 block ${input}`} />
          </label>
          <button type="submit" className="rounded-lg bg-lime px-4 py-1.5 text-xs font-extrabold text-ink hover:bg-[#e6ffa8]">Filter</button>
          <Link href="/system/activity" className="rounded-lg bg-white/10 px-4 py-1.5 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">Reset</Link>
        </form>

        <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
          {!configured ? (
            <p className="px-6 py-10 text-sm text-slate-400">Backend not configured — audit feed unavailable.</p>
          ) : rows.length === 0 ? (
            <p className="px-6 py-10 text-sm text-slate-400">No audit events match these filters.</p>
          ) : (
            <table className="w-full min-w-[980px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["When (UTC)", "Actor", "Role", "Action", "Resource", "Env", "Detail"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const href = resourceHref(r.resource);
                  return (
                    <tr key={String(r.id)} className="border-b border-white/5 align-top last:border-0">
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-slate-400">{when(r.created_at)}</td>
                      <td className="px-4 py-3 font-mono text-slate-400">{r.actor_id ? r.actor_id.slice(0, 8) : "system"}</td>
                      <td className={`px-4 py-3 font-mono font-bold ${ROLE_TONE[r.actor_role] ?? "text-slate-300"}`}>{r.actor_role}</td>
                      <td className="px-4 py-3 font-mono font-bold text-slate-200">{r.action}</td>
                      <td className="max-w-[220px] px-4 py-3 font-mono text-slate-400">
                        {href ? <Link href={href} className="break-all underline decoration-white/20 hover:text-lime">{r.resource}</Link> : <span className="break-all">{r.resource}</span>}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-500">{r.environment}</td>
                      <td className="px-4 py-3"><Detail row={r} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        {nextCursor && (
          <div className="flex justify-end">
            <Link href={qs({ cursor: nextCursor })} className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
              Older events →
            </Link>
          </div>
        )}
      </div>
    </SystemGate>
  );
}
