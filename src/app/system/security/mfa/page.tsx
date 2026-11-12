export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { getSessionUser, devAuth } from "@/lib/auth";
import { systemRole } from "@/lib/system/rbac";
import { MfaManager } from "./MfaManager";

export const metadata: Metadata = { title: "Security — MFA & step-up" };

/**
 * /system/security/mfa — TOTP enrollment/management + step-up elevation status.
 * Page itself requires only a system role (any); factor management acts on the
 * caller's own Supabase Auth factors via their session token.
 */
export default async function SystemMfaPage() {
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const mfaAvailable = !devAuth() && Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-4">
        <div>
          <p className="eyebrow text-lime">Security</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">MFA &amp; step-up</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            TOTP factors live in Supabase Auth (<code className="font-mono text-xs">auth.mfa_factors</code>) — Zapnivo
            never stores secrets. A successful verify grants a <strong className="text-slate-200">15-minute elevation</strong>{" "}
            (<code className="font-mono text-xs">system_elevations</code>) that authorizes high-risk actions like secret
            rotation and privileged role grants. Elevation never extends your session.
          </p>
        </div>

        {!mfaAvailable && (
          <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            MFA requires Supabase Auth — unavailable in dev-store mode or when Supabase env vars are missing.
          </p>
        )}

        {role === "breakglass" && (
          <p className="rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-xs text-red-200">
            Breakglass note: every mutation still needs an approved change request — MFA elevation does not bypass that.
          </p>
        )}

        {mfaAvailable && user && (
          <MfaManager email={user.email} />
        )}

        <p className="text-xs text-slate-500">
          First-time sysadmin? See <Link href="/system/security/bootstrap" className="text-lime underline">privileged bootstrap</Link>.
          {" "}Suspended accounts are managed under{" "}
          <Link href="/system/security/users" className="text-lime underline">system users</Link>.
        </p>
      </div>
    </SystemGate>
  );
}
