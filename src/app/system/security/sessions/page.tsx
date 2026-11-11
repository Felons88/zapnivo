export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { listSessions } from "@/lib/system/security";

export const metadata: Metadata = { title: "Security — Sessions" };

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z";

export default async function SystemSessionsPage() {
  const db = serviceClient();
  const sessions = db ? await listSessions(db, { limit: 300 }) : [];
  const active = sessions.filter((s) => s.active).length;

  return (
    <SystemGate perm="system.security.audit.view">
      <div className="space-y-4">
        <div>
          <p className="eyebrow text-lime">Security</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Active sessions</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Server-authoritative session registry (<code className="font-mono text-xs">auth_sessions</code>, migration 0028).
            Sessions carry an absolute 24-hour lifetime anchored at first-seen authentication — Supabase token
            refreshes cannot extend it. Only metadata is shown (method, timestamps); session keys are truncated to
            their scheme prefix and no tokens exist in this table.
          </p>
        </div>

        <div className="flex gap-4">
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] px-5 py-3">
            <p className="eyebrow text-slate-500">Active now</p>
            <p className="mt-1 font-mono text-2xl font-bold text-lime">{active}</p>
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] px-5 py-3">
            <p className="eyebrow text-slate-500">Listed</p>
            <p className="mt-1 font-mono text-2xl font-bold">{sessions.length}</p>
          </div>
          <Link href="/system/security/policy" className="ml-auto self-center rounded-full bg-white/10 px-4 py-2 text-xs font-bold text-slate-200 ring-1 ring-white/15 hover:bg-white/15">
            Session policy →
          </Link>
        </div>

        <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
          {!db ? (
            <p className="px-6 py-10 text-sm text-slate-400">Backend not configured — session registry unavailable.</p>
          ) : sessions.length === 0 ? (
            <p className="px-6 py-10 text-sm text-slate-400">No live sessions. Sessions appear here on next sign-in (registry path or anchor-cookie fallback).</p>
          ) : (
            <table className="w-full min-w-[980px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["User", "Auth", "Session", "System role", "Created", "Last seen", "Expires", "Status"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {sessions.map((s, i) => (
                  <tr key={`${s.user_id}-${i}`} className="border-b border-white/5 align-top last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-bold text-slate-200">{s.full_name || s.email || s.user_id.slice(0, 8)}</div>
                      <div className="font-mono text-[10px] text-slate-500">{s.email ?? s.user_id.slice(0, 8)}</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-400">{s.auth_method ?? "unknown"}</td>
                    <td className="px-4 py-3 font-mono text-[10px] text-slate-500">{s.session_key}:…</td>
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-400">{s.system_role ?? "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-slate-500">{when(s.created_at)}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-slate-400">{when(s.last_seen_at)}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-slate-400">{when(s.expires_at)}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${s.active ? "bg-lime/15 text-lime ring-lime/30" : s.revoked_at ? "bg-red-500/15 text-red-300 ring-red-400/30" : "bg-white/10 text-slate-400 ring-white/15"}`}>
                        {s.active ? "active" : s.revoked_at ? "revoked" : "expired"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <p className="text-xs text-slate-500">
          Remote revocation exists via <code className="font-mono">revokeCurrentSession()</code> on logout; there is no
          admin-side "kill session" endpoint yet — <span className="text-amber-300">requires implementation</span> if
          immediate session termination for arbitrary users is needed.
        </p>
      </div>
    </SystemGate>
  );
}
