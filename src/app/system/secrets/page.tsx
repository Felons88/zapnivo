export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { listSecrets } from "@/lib/system/integrations";
import { RotateForm } from "./RotateForm";

export const metadata: Metadata = { title: "Secrets" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "never";

export default async function SecretsPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canRotate = roleCan(role, "system.secrets.rotate");
  const secrets = await listSecrets(db);

  return (
    <SystemGate perm="system.integrations.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Secrets</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Credential registry</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Metadata only — env var <em>names</em>, purposes, and whether each is configured. Values are never
            stored in this system and never returned by any endpoint.{" "}
            <strong className="text-amber-300">Rotation is request-tracked; env writes are manual via the Vercel
            dashboard.</strong> See{" "}
            <Link href="/system/changes" className="underline hover:text-white">change requests</Link> for approvals.
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
                <th className="px-4 py-3">Last rotation request</th>
                <th className="px-4 py-3">Rotation policy</th>
              </tr>
            </thead>
            <tbody>
              {secrets.map((s) => (
                <tr key={s.envVar} className="border-b border-white/5 align-top last:border-0 hover:bg-white/[0.02]">
                  <td className="px-4 py-3 font-mono text-xs font-bold">{s.envVar}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">{s.provider}</td>
                  <td className="max-w-[220px] px-4 py-3 text-xs text-slate-400">{s.purpose}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ring-1 ${s.configured ? "bg-lime/15 text-lime ring-lime/30" : "bg-white/10 text-slate-400 ring-white/15"}`}>
                      {s.configured ? "set" : "missing"}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">{when(s.lastRotatedAt)}</td>
                  <td className="max-w-[280px] px-4 py-3 text-xs text-slate-400">{s.rotation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canRotate ? (
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5">
            <h2 className="eyebrow text-slate-400">Request a rotation</h2>
            <p className="mt-2 text-xs text-slate-400">
              Creates an approved-via-change-request record (risk: high) and returns manual Vercel steps.
              A submitted value is shape-checked only — it is <strong>never stored</strong>.
            </p>
            <div className="mt-4"><RotateForm secrets={secrets.map((s) => ({ envVar: s.envVar, provider: s.provider }))} /></div>
          </section>
        ) : (
          <p className="text-xs text-slate-500">Your role can view credential metadata but cannot request rotations (requires <code className="font-mono">system.secrets.rotate</code>).</p>
        )}
      </div>
    </SystemGate>
  );
}
