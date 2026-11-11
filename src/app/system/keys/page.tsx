export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { listSecrets } from "@/lib/system/integrations";

export const metadata: Metadata = { title: "API Credentials" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "never";

/**
 * API credentials & keys — metadata only. Same registry as /system/secrets:
 * provider, env var name, purpose, configured boolean, rotation policy.
 * Values are never stored readable or returned by any endpoint. Read-only;
 * rotation requests happen on /system/secrets.
 */
export default async function KeysPage() {
  const db = serviceClient();
  const secrets = await listSecrets(db);
  const configured = secrets.filter((s) => s.configured).length;

  return (
    <SystemGate perm="system.integrations.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">API Credentials</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Keys &amp; credentials</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            {configured}/{secrets.length} env vars configured. Names, purposes, and rotation policy only —
            secret <strong className="text-amber-300">values are never shown</strong>. To request a rotation,
            use <Link href="/system/secrets" className="underline hover:text-white">/system/secrets</Link>.
          </p>
        </div>

        <div className="overflow-x-auto rounded-2xl border border-white/10">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/[0.08] bg-white/[0.06] font-mono text-[11px] uppercase tracking-wider text-slate-400">
                <th className="px-4 py-3">Env var</th>
                <th className="px-4 py-3">Provider</th>
                <th className="px-4 py-3">Purpose</th>
                <th className="px-4 py-3">Configured</th>
                <th className="px-4 py-3">Rotation policy</th>
              </tr>
            </thead>
            <tbody>
              {secrets.map((s) => (
                <tr key={s.envVar} className="border-b border-white/5 align-top last:border-0 hover:bg-white/[0.02]">
                  <td className="px-4 py-3 font-mono text-xs font-bold">{s.envVar}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">{s.provider}</td>
                  <td className="max-w-[240px] px-4 py-3 text-xs text-slate-400">{s.purpose}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ring-1 ${s.configured ? "bg-lime/15 text-lime ring-lime/30" : "bg-white/10 text-slate-400 ring-white/15"}`}>
                      {s.configured ? "set" : "missing"}
                    </span>
                  </td>
                  <td className="max-w-[300px] px-4 py-3 text-xs text-slate-400">{s.rotation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
          <h2 className="eyebrow text-slate-400">Rotation requests</h2>
          <p className="mt-2 text-xs leading-relaxed text-slate-400">
            Credential rotation is request-tracked on <Link href="/system/secrets" className="underline hover:text-white">/system/secrets</Link>:
            a request creates a high-risk change request for approval, returns manual Vercel steps, and any
            submitted value is shape-checked only — <strong>never stored</strong>. Requires{" "}
            <code className="font-mono">system.secrets.rotate</code>.
          </p>
          <p className="mt-2 font-mono text-[11px] text-slate-500">last rotation request tracked per key via system_audit_events</p>
        </section>

        <p className="text-xs text-slate-500">
          API: <code className="font-mono">GET /api/system/keys</code> · <code className="font-mono">GET /api/system/secrets</code>
        </p>
      </div>
    </SystemGate>
  );
}
