export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { listFeatureFlags } from "@/lib/system/flags";
import { FlagToggle } from "./FlagToggle";

export const metadata: Metadata = { title: "Application — Feature flags" };

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z";

export default async function FeatureFlagsPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.flags.manage");
  const flags = db ? await listFeatureFlags(db, "production") : [];

  return (
    <SystemGate perm="system.flags.view">
      <div className="space-y-4">
        <div>
          <p className="eyebrow text-lime">Application</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Feature flags</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Control-plane metadata + audit trail. Toggling records intent and writes a system audit event —
            it does <strong className="text-slate-200">not</strong> change runtime behavior. Actual gating is still
            governed by env vars and code paths (e.g. <code className="font-mono text-xs">giftSalesEnabled()</code>,{" "}
            <code className="font-mono text-xs">KIOSK_ADAPTER</code>, Stripe config). Flags become live only when a
            later stage wires a real reader.
          </p>
        </div>

        <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
          {!db ? (
            <p className="px-6 py-10 text-sm text-slate-400">Backend not configured — flags unavailable.</p>
          ) : flags.length === 0 ? (
            <p className="px-6 py-10 text-sm text-slate-400">No flags seeded. Apply migration 0042.</p>
          ) : (
            <table className="w-full min-w-[860px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["Key", "State", "Owner", "Prerequisites", "Description", "Updated"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {flags.map((f) => (
                  <tr key={f.key} className="border-b border-white/5 align-top last:border-0">
                    <td className="px-4 py-3 font-mono font-bold text-lime">{f.key}</td>
                    <td className="px-4 py-3"><FlagToggle flagKey={f.key} enabled={f.enabled} canManage={canManage} /></td>
                    <td className="px-4 py-3 font-mono text-slate-400">{f.owner}</td>
                    <td className="max-w-[220px] px-4 py-3">
                      <code className="line-clamp-2 break-all text-[10px] text-slate-500">{JSON.stringify(f.prerequisites)}</code>
                    </td>
                    <td className="max-w-sm px-4 py-3 text-slate-300">{f.description}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-slate-500">{when(f.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        {!canManage && <p className="text-xs text-slate-500">Your role can view flags but not toggle them (requires system.flags.manage).</p>}
      </div>
    </SystemGate>
  );
}
