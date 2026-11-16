/**
 * Shared launch-readiness vocabulary — types and static catalogs with NO
 * server-only imports. Safe for client components (the launch board) and
 * server code alike. The evaluation engine lives in ./launch.ts.
 */

export type CheckState =
  | "verified"
  | "operational"
  | "configured"
  | "implemented"
  | "test_verified"
  | "pending"
  | "blocked"
  | "manual";

export type CheckSeverity = "critical" | "high" | "medium" | "low";
export type CheckOwner = "owner" | "developer" | "provider" | "hardware";
export type LaunchGateId = "production_safety" | "hardware_launch" | "commercial" | "optional";
export type LaunchLineId = "public_website" | "charging_rental" | "vending_ops" | "full_platform";

export type LaunchSubsystemId =
  | "website_domains"
  | "auth_security"
  | "customer_portal"
  | "partner_portal"
  | "communications"
  | "ai_infrastructure"
  | "payments"
  | "kiosk_hardware"
  | "deployments"
  | "system_control"
  | "observability"
  | "data_retention"
  | "backup_recovery"
  | "legal_compliance";

export const LAUNCH_SUBSYSTEMS: readonly { id: LaunchSubsystemId; label: string }[] = [
  { id: "website_domains", label: "Website & Domains" },
  { id: "auth_security", label: "Authentication & Security" },
  { id: "customer_portal", label: "Customer Portal" },
  { id: "partner_portal", label: "Partner Portal" },
  { id: "communications", label: "Communications" },
  { id: "ai_infrastructure", label: "AI Infrastructure" },
  { id: "payments", label: "Payments" },
  { id: "kiosk_hardware", label: "Kiosk Hardware" },
  { id: "deployments", label: "Deployments" },
  { id: "system_control", label: "System Control" },
  { id: "observability", label: "Observability" },
  { id: "data_retention", label: "Data Retention" },
  { id: "backup_recovery", label: "Backup & Recovery" },
  { id: "legal_compliance", label: "Legal & Compliance" },
];

export const LAUNCH_GATES: readonly { id: LaunchGateId; label: string; description: string }[] = [
  { id: "production_safety", label: "Critical production safety", description: "Recovery, auth security, payment integrity, legal compliance, incident response." },
  { id: "hardware_launch", label: "Hardware launch", description: "Vendor gateway, device authentication, physical certification, dispense/return verification." },
  { id: "commercial", label: "Commercial readiness", description: "Checkout, pricing, partner arrangements, support, customer communication." },
  { id: "optional", label: "Optional enhancements", description: "AI features, newsletter automation, forecasting, firmware automation — never block unrelated launches." },
];

export const LAUNCH_LINES: readonly { id: LaunchLineId; label: string }[] = [
  { id: "public_website", label: "Public vending services website" },
  { id: "charging_rental", label: "Portable charging rental" },
  { id: "vending_ops", label: "Equipment placement operations" },
  { id: "full_platform", label: "Full commercial platform" },
];

export type LaunchCheck = {
  /** Stable id — also the blocker id and history key. Never rename casually. */
  id: string;
  subsystem: LaunchSubsystemId;
  gate: LaunchGateId;
  /** Business lines this check is relevant to. */
  lines: LaunchLineId[];
  label: string;
  description: string;
  state: CheckState;
  /** Severity of the gap IF this check is unsatisfied. */
  severity: CheckSeverity;
  /** What was actually observed — counts, timestamps, env names. Never secrets. */
  evidence: string;
  /** Provenance of the evidence. */
  evidenceKind: "live_db" | "provider_recorded" | "env" | "code" | "manual" | "none";
  lastChecked: string;
  /** Concrete next step when unsatisfied; null when satisfied. */
  action: string | null;
  /** System Control page (or external setup page) that resolves it. */
  actionHref: string | null;
  /** Who must act. Null when nothing is required. */
  owner: CheckOwner | null;
  /** True when a machine probe can confirm completion. */
  autoVerifiable: boolean;
  /** True when only an authorized human can complete/attest the step. */
  manualRequired: boolean;
};

export type LaunchBlocker = {
  /** Stable blocker id = check id (one blocker per check — dedupe by construction). */
  id: string;
  checkId: string;
  subsystem: LaunchSubsystemId;
  gate: LaunchGateId;
  severity: CheckSeverity;
  problem: string;
  action: string;
  owner: CheckOwner;
  href: string | null;
  evidenceStatus: CheckState;
  lastChecked: string;
};

export type LaunchGateReport = {
  id: LaunchGateId;
  label: string;
  description: string;
  total: number;
  satisfied: number;
  /** Worst unsatisfied state across the gate's checks. */
  worst: CheckState | "satisfied";
  criticalOpen: number;
};

export type LaunchSummary = {
  productionVerified: number;
  operational: number;
  needsConfiguration: number;
  criticalBlockers: number;
  manualPending: number;
  total: number;
};

export type ReadinessHistoryEvent = {
  id: number;
  check_id: string;
  previous_state: string | null;
  new_state: string;
  evidence: string | null;
  actor: string;
  reason: string | null;
  created_at: string;
};

export type LaunchReadiness = {
  generatedAt: string;
  environment: string;
  checks: LaunchCheck[];
  subsystems: { id: LaunchSubsystemId; label: string; checks: LaunchCheck[] }[];
  blockers: LaunchBlocker[];
  gates: LaunchGateReport[];
  ownerActions: LaunchBlocker[];
  history: ReadinessHistoryEvent[];
  summary: LaunchSummary;
};
