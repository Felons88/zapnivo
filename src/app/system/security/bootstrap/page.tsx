export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { getSessionUser, devAuth } from "@/lib/auth";
import { bootstrapConfigured } from "@/lib/system/identity";
import { BootstrapForm } from "./BootstrapForm";

export const metadata: Metadata = { title: "Security — Privileged bootstrap" };

/**
 * /system/security/bootstrap — ONE-TIME privileged bootstrap.
 *
 * Deliberately NOT wrapped in SystemGate: the entire point is granting
 * profiles.system_role='sysadmin' to a signed-in user who has NO system role
 * yet. The page requires only a session; the API enforces the env token,
 * email confirmation, verified TOTP, and one-time consumption.
 */
export default async function BootstrapPage() {
  const user = await getSessionUser();
  const configured = bootstrapConfigured();
  const mfaAvailable = !devAuth() && Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <p className="eyebrow text-lime">Security</p>
        <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Privileged bootstrap</h1>
        <p className="mt-1 text-sm text-slate-400">
          One-time path to <code className="font-mono text-xs">system_role = sysadmin</code> for the first
          technical operator. Requires the <code className="font-mono text-xs">SYSTEM_BOOTSTRAP_TOKEN</code> env
          secret, your signed-in email, and a verified TOTP factor. It cannot overwrite an existing role and
          cannot be replayed.
        </p>
      </div>

      {!user ? (
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-8 text-center">
          <p className="text-sm text-slate-300">Sign in first — bootstrap acts on your authenticated session.</p>
          <Link href="/login?next=%2Fsystem%2Fsecurity%2Fbootstrap" className="mt-4 inline-block rounded-full bg-lime px-4 py-2 font-mono text-xs font-bold text-ink">Sign in</Link>
        </div>
      ) : !configured ? (
        <div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 p-6">
          <h2 className="font-display text-lg font-bold text-amber-200">Bootstrap not configured</h2>
          <p className="mt-2 text-sm text-amber-100/90">
            <code className="font-mono text-xs">SYSTEM_BOOTSTRAP_TOKEN</code> is not set, so the self-service
            bootstrap path is disabled. Use the documented manual grant procedure instead:
          </p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-amber-100/90">
            <li>Set <code className="font-mono text-xs">SYSTEM_BOOTSTRAP_TOKEN</code> to a long random value in the deployment env (and <code className="font-mono text-xs">.env.example</code> documents it).</li>
            <li>Or grant manually via the service role: <code className="font-mono text-xs">update profiles set system_role='sysadmin' where id=&lt;uuid&gt;</code> and record the grant in <code className="font-mono text-xs">system_audit_events</code> + <code className="font-mono text-xs">system_bootstrap_grants</code>.</li>
            <li>Enroll TOTP at <Link href="/system/security/mfa" className="underline">MFA &amp; step-up</Link> before performing high-risk actions.</li>
          </ol>
        </div>
      ) : (
        <div className="space-y-4">
          {!mfaAvailable && (
            <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
              MFA requires Supabase Auth — unavailable in dev-store mode. Bootstrap cannot complete without a
              verified TOTP factor.
            </p>
          )}
          <BootstrapForm email={user.email} mfaAvailable={mfaAvailable} />
        </div>
      )}
    </div>
  );
}
