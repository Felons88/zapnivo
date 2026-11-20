export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import Link from "next/link";
import { getSessionUser, isStaff } from "@/lib/auth";
import { subUrl } from "@/lib/site";
import { serviceClient } from "@/lib/supabase";
import { visibleSystemApps } from "@/lib/system/apps";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { SystemAppLauncher } from "@/components/SystemAppLauncher";

export const metadata: Metadata = { title: "Applications" };

export default async function SystemHome() {
  const user = await getSessionUser();
  const role = await systemRole(user);
  const businessStaff = isStaff(user);
  if (!user || (!role && !businessStaff)) {
    return <div className="mx-auto max-w-xl rounded-2xl border border-[var(--sys-border)] bg-[var(--sys-surface)] p-8 text-center">
      <p className="text-xs font-bold uppercase tracking-wider text-[var(--sys-accent)]">Access restricted</p>
      <h1 className="mt-3 text-2xl font-bold text-[var(--sys-text)]">No internal applications available</h1>
      <p className="mt-2 text-sm text-[var(--sys-muted)]">Your account needs a staff or system role to open this workspace.</p>
    </div>;
  }

  const db = serviceClient();
  const [assigned, pendingChanges, deviceAttention] = await Promise.all([
    businessStaff && db
      ? db.from("support_tickets").select("id", { count: "exact", head: true }).eq("assigned_to", user.id).in("state", ["open", "pending_customer", "pending_internal"])
      : Promise.resolve(null),
    roleCan(role, "system.changes.view") && db
      ? db.from("system_change_requests").select("id", { count: "exact", head: true }).eq("status", "pending")
      : Promise.resolve(null),
    roleCan(role, "system.kiosks.view") && db
      ? db.from("system_devices").select("id", { count: "exact", head: true }).in("status", ["quarantined", "suspended", "maintenance"])
      : Promise.resolve(null),
  ]);
  const apps = visibleSystemApps(role, businessStaff, user.role === "admin").map((app) => app.businessStaff
    ? { ...app, href: subUrl("internal", app.href.replace(/^\/admin/, "") || "/") }
    : app);
  const name = user.email.split("@")[0]?.replace(/[._-]+/g, " ") || "there";
  const signals = [
    businessStaff ? { label: "Assigned support cases", value: assigned?.error ? null : assigned?.count ?? null, href: subUrl("internal", "/support?view=mine") } : null,
    roleCan(role, "system.changes.view") ? { label: "Pending changes", value: pendingChanges?.error ? null : pendingChanges?.count ?? null, href: "/system/changes" } : null,
    roleCan(role, "system.kiosks.view") ? { label: "Devices needing review", value: deviceAttention?.error ? null : deviceAttention?.count ?? null, href: "/system/kiosks" } : null,
  ].filter((signal): signal is { label: string; value: number | null; href: string } => !!signal);

  return <div className="space-y-9">
    <header className="flex flex-wrap items-end justify-between gap-5">
      <div>
        <p className="text-xs font-bold uppercase tracking-[.16em] text-[var(--sys-accent)]">Zapnivo workspace</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-[var(--sys-text)] sm:text-4xl">Good to see you, <span className="capitalize">{name}</span>.</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--sys-muted)]">Choose an application to continue your work. You only see applications your account can open.</p>
      </div>
      <span className="rounded-full border border-[var(--sys-border)] bg-[var(--sys-surface)] px-4 py-2 text-xs font-bold uppercase tracking-wider text-[var(--sys-muted)]">{role ?? (businessStaff ? "Business staff" : "Restricted")}</span>
    </header>

    {signals.length > 0 && <section aria-label="Your work" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {signals.map((signal) => <Link key={signal.label} href={signal.href} className="flex min-h-24 items-center justify-between gap-4 rounded-2xl border border-[var(--sys-border)] bg-[var(--sys-surface)] px-5 py-4 text-[var(--sys-text)] transition hover:border-[var(--sys-accent)]">
        <span><span className="block text-xs font-bold uppercase tracking-wider text-[var(--sys-muted)]">{signal.label}</span><span className="mt-1 block text-2xl font-bold">{signal.value ?? "—"}</span></span><span aria-hidden className="text-[var(--sys-accent)]">↗</span>
      </Link>)}
    </section>}

    <SystemAppLauncher apps={apps} />
  </div>;
}
