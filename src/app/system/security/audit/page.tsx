export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Security — Audit log" };

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "UTC" }) + "Z";

export default async function SystemAuditPage({ searchParams }: { searchParams: Promise<{ action?: string; resource?: string; actor?: string }> }) {
  const { action, resource, actor } = await searchParams;
  const db = serviceClient();

  let q = db?.from("system_audit_events")
    .select("id,actor_id,actor_role,action,resource,environment,detail,correlation_id,created_at")
    .order("created_at", { ascending: false }).limit(300);
  if (q && action) q = q.eq("action", action);
  if (q && resource) q = q.eq("resource", resource);
  if (q && actor) q = q.eq("actor_id", actor);
  const res = q ? await q : null;
  const rows = (res?.data ?? []) as {
    id: string; actor_id: string | null; actor_role: string | null; action: string;
    resource: string; environment: string; detail: unknown; correlation_id: string | null; created_at: string;
  }[];
  const actions = [...new Set(rows.map((r) => r.action))].sort();
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { action, resource, actor, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/system/security/audit${s ? `?${s}` : ""}`;
  };

  return (
    <SystemGate perm="system.security.audit.view">
      <div className="space-y-4">
        <div>
          <p className="eyebrow text-lime">Security</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">System audit log</h1>
          <p className="mt-1 text-sm text-slate-400">Append-only. Writes happen via the service role; this view is select-only.</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link href={qs({ action: undefined })} className={`rounded-full px-3 py-1.5 text-xs font-bold ${!action ? "bg-lime text-ink" : "bg-white/10 text-slate-200 ring-1 ring-white/15 hover:bg-white/15"}`}>All actions</Link>
          {actions.map((a) => (
            <Link key={a} href={qs({ action: a })} className={`rounded-full px-3 py-1.5 font-mono text-[11px] font-bold ${action === a ? "bg-lime text-ink" : "bg-white/10 text-slate-200 ring-1 ring-white/15 hover:bg-white/15"}`}>{a}</Link>
          ))}
        </div>

        <section className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.04]">
          {!db ? (
            <p className="px-6 py-10 text-sm text-slate-400">Backend not configured — audit events unavailable.</p>
          ) : rows.length === 0 ? (
            <p className="px-6 py-10 text-sm text-slate-400">No audit events{action || resource || actor ? " match the current filters" : " yet"}.</p>
          ) : (
            <table className="w-full min-w-[900px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["When", "Actor", "Role", "Action", "Resource", "Env", "Detail", "Correlation"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody className="font-mono">
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-white/5 align-top last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 text-slate-400">{when(r.created_at)}</td>
                    <td className="px-4 py-3 text-slate-300">{r.actor_id ? r.actor_id.slice(0, 8) : "system"}</td>
                    <td className="px-4 py-3 text-slate-400">{r.actor_role ?? "—"}</td>
                    <td className="px-4 py-3 font-bold text-lime">{r.action}</td>
                    <td className="px-4 py-3 text-slate-300">{r.resource || "—"}</td>
                    <td className="px-4 py-3 text-slate-400">{r.environment}</td>
                    <td className="max-w-xs px-4 py-3"><code className="line-clamp-2 break-all text-[10px] text-slate-500">{r.detail && Object.keys(r.detail as object).length ? JSON.stringify(r.detail) : "—"}</code></td>
                    <td className="px-4 py-3 text-[10px] text-slate-500">{r.correlation_id ? r.correlation_id.slice(0, 10) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </SystemGate>
  );
}
