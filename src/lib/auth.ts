import { cookies } from "next/headers";
import { anonClient, serviceClient } from "./supabase";

export type Role = "admin" | "staff" | "partner" | "customer";
export type SessionUser = { id: string; email: string; role: Role; organizationId: string | null };

export const SESSION_COOKIE = "zapnivo_access";

/**
 * DEV ONLY: with HELPDESK_DEV_STORE=1 under `next dev`, sign-in is bypassed and you act as a synthetic user
 * (switch with /api/dev/as?role=admin|admin2|agent|partner). Hard-disabled in production builds.
 */
export const devAuth = () => process.env.NODE_ENV === "development" && process.env.HELPDESK_DEV_STORE === "1";
export const DEV_USERS = {
  admin: { id: "dev-admin", email: "admin@dev.local", role: "admin", organizationId: "dev-org" },
  admin2: { id: "dev-admin-2", email: "admin2@dev.local", role: "admin", organizationId: "dev-org" },
  agent: { id: "dev-agent", email: "agent@dev.local", role: "staff", organizationId: "dev-org" },
  partner: { id: "dev-partner", email: "owner@demo-tavern.local", role: "partner", organizationId: "dev-org" },
} as const satisfies Record<string, SessionUser>;
export const DEV_COOKIE = "zapnivo_dev_as";

export const authConfigured = () => devAuth() || Boolean(anonClient() && serviceClient());

/** Verifies the access token with Supabase and loads the role server-side. Returns null when unauthenticated. */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (devAuth()) {
    const as = (await cookies()).get(DEV_COOKIE)?.value as keyof typeof DEV_USERS | undefined;
    return { ...DEV_USERS[as && as in DEV_USERS ? as : "admin"] };
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const anon = anonClient();
  const svc = serviceClient();
  if (!token || !anon || !svc) return null;
  const { data, error } = await anon.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: profile } = await svc.from("profiles").select("role, organization_id").eq("id", data.user.id).single();
  if (!profile) return null;
  return { id: data.user.id, email: data.user.email ?? "", role: profile.role as Role, organizationId: profile.organization_id };
}

export const isStaff = (u: SessionUser | null) => u?.role === "admin" || u?.role === "staff";
