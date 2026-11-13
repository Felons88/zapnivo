export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import {
  EMERGENCY_PAUSABLE_FLAGS,
  getMaintenanceNotice,
  listEmergencyActions,
} from "@/lib/system/emergency";
import { listFleetDevices } from "@/lib/system/kiosks";
import { listAgents } from "@/lib/agents/registry";
import { listFeatureFlags } from "@/lib/system/flags";
import { EmergencyConsole } from "./EmergencyConsole";

export const metadata: Metadata = { title: "Emergency controls" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "never";

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] p-5 ${className}`}>
      <h2 className="eyebrow text-slate-400">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default async function SystemEmergencyPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.users.manage");

  const [actions, fleet, agents, flags, notice] = db
    ? await Promise.all([
        listEmergencyActions(db, 50),
        listFleetDevices(db, { limit: 200 }),
        listAgents(db),
        listFeatureFlags(db),
        getMaintenanceNotice(db),
      ])
    : [[], { devices: [] }, [], [], null] as const;

  const devices = fleet.devices.map((d) => ({
    id: d.id,
    label: `${d.device_uid ?? d.id.slice(0, 8)} · ${d.status}${d.venue?.name ? ` · ${d.venue.name}` : ""}`,
  }));
  const agentOptions = agents.map((a) => ({ id: a.id, label: `${a.id} — ${a.name} (${a.enabled ? "enabled" : "disabled"})` }));
  const pausableFlags = EMERGENCY_PAUSABLE_FLAGS.map((key) => {
    const f = flags.find((x) => x.key === key);
    return { key, enabled: f?.enabled ?? null as boolean | null, description: f?.description ?? "" };
  });

  return (
    <SystemGate perm="system.security.audit.view">
      <div className="space-y-6">
        <div>
          <p className="eyebrow text-red-300">Emergency</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Emergency controls</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Scoped incident actions only — every operation names exactly ONE target. There is deliberately{" "}
            <strong className="text-slate-200">no global kill switch</strong>. Each op requires{" "}
            <code className="font-mono text-xs">system.users.manage</code>, a live{" "}
            <Link href="/system/security/mfa" className="text-lime underline">MFA step-up</Link>, passes the change-request
            gate, and writes a <code className="font-mono text-xs">system_audit_events</code> row. Payment, auth, and
            secret-rotation surfaces are not reachable from here.
          </p>
        </div>

        {notice && (
          <div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 px-5 py-3 text-sm text-amber-200">
            Active maintenance notice: <span className="font-bold">{notice.message}</span>{" "}
            <span className="font-mono text-xs">(expires {when(notice.expiresAt)})</span>
          </div>
        )}

        <EmergencyConsole
          canManage={canManage}
          configured={Boolean(db)}
          devices={devices}
          agents={agentOptions}
          pausableFlags={pausableFlags}
        />

        <Card title="Recent emergency actions" className="!p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["When", "Op", "Target", "Actor", "Reason", "CR"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {actions.map((a) => {
                  const d = a.detail ?? {};
                  return (
                    <tr key={a.id} className="border-b border-white/5 last:border-0">
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[10px] text-slate-500">{when(a.created_at)}</td>
                      <td className="px-4 py-2.5 font-mono font-bold text-red-300">{String(d.op ?? a.action.replace(/^emergency\./, ""))}</td>
                      <td className="max-w-[14rem] truncate px-4 py-2.5 font-mono text-[10px] text-slate-400" title={String(d.target ?? a.resource)}>{String(d.target ?? a.resource)}</td>
                      <td className="px-4 py-2.5 font-mono text-[10px] text-slate-400">{a.actor_role ?? "?"} · {(a.actor_id ?? "").slice(0, 8)}</td>
                      <td className="max-w-[18rem] truncate px-4 py-2.5 text-[11px] text-slate-400" title={String(d.reason ?? "")}>{String(d.reason ?? "—")}</td>
                      <td className="px-4 py-2.5 font-mono text-[10px] text-slate-500">{d.change_request_id ? "cr" : "—"}</td>
                    </tr>
                  );
                })}
                {actions.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">No emergency operations recorded in the audit log.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="border-t border-white/5 px-5 py-3 text-[11px] text-slate-500">
            Source: <code className="font-mono">system_audit_events</code> where action LIKE <code className="font-mono">emergency.%</code>.
            Pending change requests appear under <Link href="/system/changes" className="text-lime underline">Change requests</Link>.
          </p>
        </Card>
      </div>
    </SystemGate>
  );
}
