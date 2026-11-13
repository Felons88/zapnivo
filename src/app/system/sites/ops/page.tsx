export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { getMaintenanceNotice } from "@/lib/system/emergency";
import { listRedirects, siteOpsSummary } from "@/lib/system/site-ops";
import { OpsConsole } from "./OpsConsole";

export const metadata: Metadata = { title: "Website ops" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "never";

/**
 * /system/sites/ops — website operational controls: maintenance notice,
 * DB-driven redirect rules, per-site ops summary. Mutations require
 * system.flags.manage; the notice path delegates to the emergency
 * maintenance_banner op (step-up elevation + change-request gates intact).
 */
export default async function SiteOpsPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.flags.manage");

  const [notice, redirects, summary] = db
    ? await Promise.all([getMaintenanceNotice(db), listRedirects(db), siteOpsSummary(db)])
    : [null, [], { configured: false, sites: [], redirectTotal: 0 }] as const;

  const siteOptions = summary.sites.map((s) => ({ key: s.key, label: `${s.label} (${s.host})` }));

  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-6">
        <div>
          <p className="eyebrow text-lime">Website</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Site operations</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            Maintenance notices and redirect rules. Redirect targets are restricted to relative paths or
            same-host Zapnivo URLs — arbitrary external redirects are rejected. Every mutation is audited;
            breakglass additionally needs an approved change request. CMS content lives under{" "}
            <Link href="/system/sites" className="text-lime underline">Sites</Link>.
          </p>
        </div>

        {!db ? (
          <p className="rounded-2xl border border-white/[0.08] bg-white/[0.05] px-6 py-10 text-sm text-slate-400">
            Backend not configured — site ops unavailable.
          </p>
        ) : (
          <>
            {notice && (
              <div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 px-5 py-3 text-sm text-amber-200">
                Active maintenance notice ({notice.severity}): <span className="font-bold">{notice.message}</span>{" "}
                <span className="font-mono text-xs">(expires {when(notice.expiresAt)})</span>
              </div>
            )}

            <OpsConsole
              canManage={canManage}
              configured={Boolean(db)}
              notice={notice ? { text: notice.message, severity: notice.severity, expiresAt: notice.expiresAt } : null}
              redirects={redirects.map((r) => ({
                id: r.id, site_key: r.site_key, from_path: r.from_path, to_path: r.to_path,
                enabled: r.enabled, note: r.note, created_at: r.created_at,
              }))}
              sites={siteOptions}
            />

            <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
              <h2 className="eyebrow text-slate-400">Site status</h2>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
                    <tr>{["Site", "Host", "Class", "Redirects", "Enabled"].map((h) => <th key={h} className="px-3 py-2 font-extrabold">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {summary.sites.map((s) => (
                      <tr key={s.key} className="border-b border-white/5 last:border-0">
                        <td className="px-3 py-2 font-bold text-slate-200">{s.label}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-slate-400">{s.host}</td>
                        <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ring-1 ${s.classification === "public" ? "bg-lime/15 text-lime ring-lime/30" : "bg-white/10 text-slate-300 ring-white/15"}`}>{s.classification}</span></td>
                        <td className="px-3 py-2 font-mono text-[11px] text-slate-400">{s.redirects}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-slate-400">{s.redirectsEnabled}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-[11px] text-slate-500">
                Operational status is registry + config truth only — live host health is not probed here
                (see deployments / observability for release and uptime data). The public banner reader is{" "}
                <code className="font-mono">src/lib/maintenance-notice.ts</code> (30s cache); mounting it in the
                site layout is a pending 3-line addition owned by the layout maintainer.
              </p>
            </section>
          </>
        )}
      </div>
    </SystemGate>
  );
}
