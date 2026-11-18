/**
 * Dev-mode auth switcher — a tiny, edge-safe module with NO node:crypto (or any
 * node-only) imports. Pulled out of lib/auth so modules bundled into the Edge
 * runtime (rbac → instrumentation chain) can read it without dragging the
 * HMAC session-anchor code into the edge bundle.
 */

export type SessionUser = { id: string; email: string; role: "admin" | "staff" | "customer" | "partner"; organizationId: string | null };

export const devAuth = () => process.env.NODE_ENV === "development" && process.env.HELPDESK_DEV_STORE === "1";
export const DEV_USERS = {
  admin: { id: "dev-admin", email: "admin@dev.local", role: "admin", organizationId: "dev-org" },
  admin2: { id: "dev-admin-2", email: "admin2@dev.local", role: "admin", organizationId: "dev-org" },
  agent: { id: "dev-agent", email: "agent@dev.local", role: "staff", organizationId: "dev-org" },
  partner: { id: "dev-partner", email: "owner@demo-tavern.local", role: "partner", organizationId: "dev-org" },
} as const satisfies Record<string, SessionUser>;
export const DEV_COOKIE = "zapnivo_dev_as";
