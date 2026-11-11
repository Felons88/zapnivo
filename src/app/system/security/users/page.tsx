export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { listSystemUsers } from "@/lib/system/security";
import { UserAdmin } from "./UserAdmin";

export const metadata: Metadata = { title: "Security — System users" };

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z";

const ROLE_TONE: Record<string, string> = {
  sysadmin: "bg-lime/15 text-lime ring-lime/30",
  breakglass: "bg-red-500/15 text-red-300 ring-red-400/30",
  security: "bg-sky-400/15 text-sky-300 ring-sky-400/30",
  engineer: "bg-violet-400/15 text-violet-300 ring-violet-400/30",
  developer: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  hardware: "bg-teal-400/15 text-teal-300 ring-teal-400/30",
  viewer: "bg-white/10 text-slate-300 ring-white/15",
};

export default async function SystemUsersPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.users.manage");
  const users = db ? await listSystemUsers(db) : [];
  const selfId = user?.id ?? null;

  return (
    <SystemGate perm="system.security.audit.view">
      <div className="space-y-4">
        <div>
          <p className="eyebrow text-lime">Security</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">System users</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Technical access tier (<code className="font-mono text-xs">profiles.system_role</code>) — separate from
            business roles. Granting <code className="font-mono text-xs">breakglass</code> or any change by a
            breakglass principal requires an approved change request (separation of duties). You cannot modify your
            own role. Every change is written to the{" "}
            <Link href="/system/security/audit" className="text-lime underline">system audit log</Link>.
          </p>
        </div>

        <section className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
          {!db ? (
            <p className="px-6 py-10 text-sm text-slate-400">Backend not configured — user directory unavailable.</p>
          ) : users.length === 0 ? (
            <p className="px-6 py-10 text-sm text-slate-400">No users hold a system role or staff business role yet.</p>
          ) : (
            <table className="w-full min-w-[900px] text-left text-xs">
              <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                <tr>{["User", "Business role", "System role", "MFA flag", "Created", canManage ? "Manage" : "Role"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-white/5 align-top last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-bold text-slate-200">{u.full_name || u.email}</div>
                      <div className="font-mono text-[10px] text-slate-500">{u.email}{u.id === selfId ? " · you" : ""}</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-400">{u.business_role}</td>
                    <td className="px-4 py-3">
                      {u.system_role ? (
                        <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ring-1 ${ROLE_TONE[u.system_role] ?? "bg-white/10 text-slate-300 ring-white/15"}`}>{u.system_role}</span>
                      ) : (
                        <span className="font-mono text-[11px] text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px]">
                      <span className={u.mfa_required ? "text-lime" : "text-slate-500"}>{u.mfa_required ? "required" : "not required"}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-slate-500">{when(u.created_at)}</td>
                    <td className="px-4 py-3">
                      {u.id === selfId ? (
                        <span className="font-mono text-[10px] text-slate-500">self — locked</span>
                      ) : (
                        <UserAdmin userId={u.id} currentRole={u.system_role} canManage={canManage} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {!canManage && (
          <p className="text-xs text-slate-500">
            Your role can view this directory but not modify roles — grants require <code className="font-mono">system.users.manage</code> (security/sysadmin/breakglass).
          </p>
        )}
      </div>
    </SystemGate>
  );
}
