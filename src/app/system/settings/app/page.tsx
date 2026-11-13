export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import { listAppSettings } from "@/lib/system/app-settings";
import { AppSettingsEditor } from "./AppSettingsEditor";

export const metadata: Metadata = { title: "Application — App settings" };

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "never";

export default async function AppSettingsPage() {
  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.flags.manage");
  const list = await listAppSettings(db);

  return (
    <SystemGate perm="system.flags.view">
      <div className="space-y-4">
        <div>
          <p className="eyebrow text-lime">Application</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">App settings</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Whitelisted, <strong className="text-slate-200">nonsecret</strong> application settings
            (<code className="font-mono text-xs">system_app_settings</code>). Only registry keys can be
            written — arbitrary keys and secret-looking values are rejected. Every write is audited;
            <span className="text-amber-300"> high-risk</span> keys additionally require step-up
            elevation (MFA) and an approved change request. Values are configuration data — a key
            without a wired runtime reader records intended state only.
          </p>
        </div>

        {!list.configured || !list.storeAvailable ? (
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-6">
            <p className="text-sm text-slate-400">
              {!list.configured
                ? "Backend not configured — settings unavailable."
                : "Settings store unavailable — apply migration 0065 (system_app_settings). Showing registry defaults."}
            </p>
          </section>
        ) : (
          <AppSettingsEditor settings={list.settings} canManage={canManage} when={when} />
        )}

        {!canManage && list.configured && (
          <p className="text-xs text-slate-500">Your role can view settings but not edit them (requires system.flags.manage).</p>
        )}
      </div>
    </SystemGate>
  );
}
