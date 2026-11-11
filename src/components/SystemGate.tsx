import type { ReactNode } from "react";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole, type SystemPermission, type SystemRole } from "@/lib/system/rbac";
import { LogoutButton } from "./LogoutButton";

/**
 * Per-page permission gate for the system console. Every /system page wraps its
 * content in <SystemGate perm="...">. Denials render an honest restricted
 * screen (403 semantics) — never a redirect loop.
 */
export async function SystemGate({
  perm,
  role: expectedRole,
  children,
}: {
  perm: SystemPermission;
  /** Optional: also require a specific system role (e.g. breakglass-only screens). */
  role?: SystemRole;
  children: ReactNode;
}) {
  const user = await getSessionUser();
  if (!user) {
    return <Restricted reason="unauthenticated" detail="Sign in to continue." perm={perm} />;
  }
  const role = await systemRole(user);
  if (!role) {
    return (
      <Restricted
        reason="no_system_access"
        detail="Your account doesn't have a system role. System access is granted separately from business roles — ask a sysadmin to assign one (profiles.system_role)."
        perm={perm}
      />
    );
  }
  const allowed = roleCan(role, perm) && (!expectedRole || role === expectedRole);
  if (!allowed) {
    return (
      <Restricted
        reason="forbidden"
        detail={`Role "${role}" lacks permission ${perm}${expectedRole ? ` or is not "${expectedRole}"` : ""}.`}
        perm={perm}
      />
    );
  }
  return <>{children}</>;
}

function Restricted({ reason, detail, perm }: { reason: string; detail: string; perm: SystemPermission }) {
  return (
    <div className="grid min-h-[60vh] place-items-center px-6">
      <div className="w-full max-w-lg rounded-2xl border border-red-900/20 bg-white p-8 text-center shadow-sm">
        <p className="eyebrow text-red-700">Access restricted</p>
        <h2 className="mt-3 font-display text-2xl font-bold">403 — system permission required</h2>
        <p className="mt-3 text-sm text-graphite">{detail}</p>
        <dl className="mx-auto mt-5 max-w-xs space-y-1 text-left text-xs">
          <div className="flex justify-between gap-4"><dt className="text-graphite">Required</dt><dd className="font-mono font-bold">{perm}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-graphite">Reason</dt><dd className="font-mono font-bold">{reason}</dd></div>
        </dl>
        <div className="mt-6 flex items-center justify-center gap-3">
          <Link href="/system" className="rounded-full bg-ink px-4 py-2 text-xs font-bold text-white hover:bg-graphite">Command Center</Link>
          <LogoutButton light />
        </div>
      </div>
    </div>
  );
}
