export const dynamic = "force-dynamic";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { LiveSync } from "@/components/LiveSync";

/** Customer-readable realtime tables — RLS scopes events to the signed-in account. */
const LIVE_TABLES = ["rentals", "entitlement_grants", "wallet_topups"];

/**
 * Live account area: rental state, credit balance and top-ups refresh in place —
 * no manual reload needed after a kiosk event or a staff-side change.
 */
export default async function AccountLayout({ children }: { children: ReactNode }) {
  const accessToken = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return (
    <>
      <LiveSync channel="account-live" tables={LIVE_TABLES} intervalMs={30000} accessToken={accessToken} />
      {children}
    </>
  );
}
