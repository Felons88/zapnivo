import { roleCan, type SystemPermission, type SystemRole } from "./rbac";

export type SystemApp = {
  id: string;
  name: string;
  description: string;
  href: string;
  category: "Business" | "Operations" | "Platform";
  icon: "care" | "customers" | "venue" | "finance" | "analytics" | "staff" | "fleet" | "monitor" | "deploy" | "settings" | "knowledge" | "sites" | "ai" | "security";
  permission?: SystemPermission;
  businessStaff?: boolean;
  adminOnly?: boolean;
};

/** Every tile has a server-side visibility rule. Destination routes keep their own guards. */
export const SYSTEM_APPS: readonly SystemApp[] = [
  { id: "customer-care", name: "Customer service", description: "Tickets, escalations, refunds, and customer conversations.", href: "/admin/support", category: "Business", icon: "care", businessStaff: true },
  { id: "customers", name: "Customer accounts", description: "Customer profiles, rentals, and account history.", href: "/admin/customers", category: "Business", icon: "customers", businessStaff: true },
  { id: "venues", name: "Venue management", description: "Locations, assignments, onboarding, and contracts.", href: "/admin/partners", category: "Business", icon: "venue", businessStaff: true },
  { id: "finance", name: "Financial operations", description: "Revenue reporting, settlements, and payouts.", href: "/admin/finance", category: "Business", icon: "finance", businessStaff: true, adminOnly: true },
  { id: "analytics", name: "Analytics", description: "Rental, network, and business performance.", href: "/admin/analytics", category: "Business", icon: "analytics", businessStaff: true },
  { id: "staff", name: "Staff administration", description: "Business users, roles, and account access.", href: "/admin/users", category: "Business", icon: "staff", businessStaff: true },
  { id: "kiosk-ops", name: "Kiosk operations", description: "Devices, commands, maintenance, and exceptions.", href: "/system/kiosks", category: "Operations", icon: "fleet", permission: "system.kiosks.view" },
  { id: "observability", name: "Observability", description: "Incidents, traces, alerts, and service health.", href: "/system/observability", category: "Operations", icon: "monitor", permission: "system.security.audit.view" },
  { id: "deployments", name: "Deployments", description: "Release state, environments, and deployment requests.", href: "/system/deployments", category: "Operations", icon: "deploy", permission: "system.deployments.view" },
  { id: "sites", name: "Websites", description: "Site content, pages, and publishing operations.", href: "/system/sites", category: "Platform", icon: "sites", permission: "system.dashboard.view" },
  { id: "infrastructure", name: "Infrastructure", description: "Database, APIs, webhooks, and scheduled jobs.", href: "/system/infrastructure", category: "Platform", icon: "settings", permission: "system.dashboard.view" },
  { id: "ai", name: "AI infrastructure", description: "Agents, models, evaluations, and guardrails.", href: "/system/ai", category: "Platform", icon: "ai", permission: "system.ai.view" },
  { id: "security", name: "Security & access", description: "Audit, technical users, sessions, and policy.", href: "/system/security/audit", category: "Platform", icon: "security", permission: "system.security.audit.view" },
  { id: "support-tools", name: "Support tools", description: "Knowledge, documentation, and support operations.", href: "/admin/knowledge", category: "Business", icon: "knowledge", businessStaff: true },
  { id: "system-overview", name: "System overview", description: "Technical readiness and current platform state.", href: "/system/overview", category: "Platform", icon: "monitor", permission: "system.dashboard.view" },
] as const;

export function visibleSystemApps(role: SystemRole | null, businessStaff: boolean, businessAdmin = false): SystemApp[] {
  return SYSTEM_APPS.filter((app) => app.businessStaff
    ? businessStaff && (!app.adminOnly || businessAdmin)
    : !!app.permission && roleCan(role, app.permission));
}
