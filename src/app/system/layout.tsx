export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { systemRole } from "@/lib/system/rbac";
import { SystemShell } from "@/components/SystemShell";

export const metadata: Metadata = {
  title: { default: "System", template: "%s · Zapnivo System" },
  robots: { index: false, follow: false },
};

/**
 * Shell for system.zapnivo.com. Requires a session; the actual permission check
 * happens per-page via <SystemGate perm="..."> so each route declares exactly
 * what it needs. Users with no system_role still get the shell + an honest
 * restricted screen inside the gated content.
 */
export default async function SystemLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const role = await systemRole(user);
  return (
    <SystemShell user={user} role={role}>
      {children}
    </SystemShell>
  );
}
