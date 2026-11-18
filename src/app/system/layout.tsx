export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";
import { systemRole } from "@/lib/system/rbac";
import { SystemShell } from "@/components/SystemShell";
import { LiveSync } from "@/components/LiveSync";

/** Staff-visible realtime tables — any change refreshes the open system page. */
const LIVE_TABLES = [
  "rentals", "payments", "support_tickets", "support_messages", "refund_requests",
  "disputes", "incident_reports", "customer_notes", "customer_data_requests",
  "sms_messages", "profiles", "entitlement_grants", "wallet_topups",
  "system_devices", "system_device_commands", "system_device_messages",
];

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
  const accessToken = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return (
    <SystemShell user={user} role={role}>
      <LiveSync channel="system-live" tables={LIVE_TABLES} intervalMs={30000} accessToken={accessToken} />
      {children}
    </SystemShell>
  );
}
