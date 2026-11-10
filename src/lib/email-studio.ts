import { renderEmail } from "./email-templates";

/**
 * Email Studio registry — the staff-facing catalog of transactional email templates.
 * Pure data + safe render helpers; safe to import from client components for the
 * template list (rendering itself always goes through /api/admin/email-studio/preview).
 */

export const EMAIL_AUDIENCES = ["Customers", "Partners", "Admin", "Operations", "Finance", "Support", "Security", "Marketing"] as const;
export type EmailAudience = (typeof EMAIL_AUDIENCES)[number];

export type EmailTemplateSpec = {
  /** Template key passed to renderEmail(). */
  name: string;
  displayName: string;
  audience: EmailAudience;
  /** Subject line; may contain {{var}} placeholders. */
  subject: string;
  description: string;
  /** Where/when this email fires in the product. Honest "planned" notes for unbuilt triggers. */
  triggerNote: string;
  /** Sample values used for previews and as the editable variable panel defaults. */
  sampleVars: Record<string, string>;
  /** Vars documented for the plain-text fallback (no dedicated text renderer exists yet). */
  textVars: string[];
};

const YEAR = "2026";

export const EMAIL_TEMPLATES: EmailTemplateSpec[] = [
  // ── Customers ────────────────────────────────────────────────────────────
  {
    name: "nonreturn_notice",
    displayName: "Non-return notice",
    audience: "Customers",
    subject: "Action needed: check your Zapnivo rental",
    description: "Warns a customer their charger rental hasn't been returned by the deadline.",
    triggerNote: "Sent when a rental passes its non-return deadline without a confirmed return.",
    sampleVars: {
      rental_id: "ZR-8F2KQ1", rental_status: "not returned", rental_url: "https://zapnivo.com/rental/ZR-8F2KQ1",
      return_deadline: "Nov 12, 2026, 6:00 PM", start_time: "Nov 5, 2026, 2:30 PM", year: YEAR,
    },
    textVars: ["rental_id", "rental_status", "rental_url", "return_deadline", "start_time"],
  },
  {
    name: "rental_started",
    displayName: "Rental started",
    audience: "Customers",
    subject: "Your Zapnivo rental is active",
    description: "Confirms a rental has started, with station and pricing details.",
    triggerNote: "Sent when a rental session begins at a station.",
    sampleVars: {
      rental_id: "ZR-8F2KQ1", rental_url: "https://zapnivo.com/rental/ZR-8F2KQ1",
      start_time: "Nov 5, 2026, 2:30 PM", venue_name: "The Demo Tavern — Downtown",
      pricing_summary: "$8/day · $45 deposit hold", year: YEAR,
    },
    textVars: ["rental_id", "rental_url", "start_time", "venue_name", "pricing_summary"],
  },
  {
    name: "rental_returned",
    displayName: "Rental returned",
    audience: "Customers",
    subject: "Your Zapnivo return is confirmed",
    description: "Confirms the charger was returned and shows the final total.",
    triggerNote: "Sent when a rental is marked returned.",
    sampleVars: {
      rental_id: "ZR-8F2KQ1", rental_total: "$12.00", rental_url: "https://zapnivo.com/rental/ZR-8F2KQ1",
      return_time: "Nov 6, 2026, 11:15 AM", return_venue: "The Demo Tavern — Downtown", year: YEAR,
    },
    textVars: ["rental_id", "rental_total", "rental_url", "return_time", "return_venue"],
  },
  {
    name: "rental_reminder",
    displayName: "Rental reminder",
    audience: "Customers",
    subject: "Reminder: your Zapnivo rental is active",
    description: "Mid-rental nudge with status and pricing recap.",
    triggerNote: "Sent on a schedule while a rental is still active.",
    sampleVars: {
      rental_id: "ZR-8F2KQ1", rental_url: "https://zapnivo.com/rental/ZR-8F2KQ1", rental_status: "active",
      start_time: "Nov 5, 2026, 2:30 PM", pricing_summary: "$8/day · $45 deposit hold", year: YEAR,
    },
    textVars: ["rental_id", "rental_url", "rental_status", "start_time", "pricing_summary"],
  },

  // ── Partners ─────────────────────────────────────────────────────────────
  {
    name: "partner_inquiry",
    displayName: "Partner inquiry received",
    audience: "Partners",
    subject: "We received your Zapnivo partnership inquiry",
    description: "Acknowledges a venue's partnership inquiry form submission.",
    triggerNote: "Sent when the public partnership inquiry form is submitted.",
    sampleVars: {
      business_name: "The Demo Tavern", contact_name: "Jordan Lee", business_location: "Austin, TX",
      inquiry_id: "INQ-4F2A9C", year: YEAR,
    },
    textVars: ["business_name", "contact_name", "business_location", "inquiry_id"],
  },
  {
    name: "partner_application_received",
    displayName: "Partner application received",
    audience: "Partners",
    subject: "We received your Zapnivo partner application",
    description: "Acknowledges a full partner application submission.",
    triggerNote: "Planned — sent when the partner application form is submitted (trigger wiring in progress).",
    sampleVars: {
      business_name: "The Demo Tavern", contact_name: "Jordan Lee", application_id: "APP-7B31D0",
      venue_name: "The Demo Tavern — Downtown", year: YEAR,
    },
    textVars: ["business_name", "contact_name", "application_id", "venue_name"],
  },
  {
    name: "partner_approved",
    displayName: "Partner approved",
    audience: "Partners",
    subject: "You're approved to host Zapnivo",
    description: "Tells a partner their application was approved and how to get started.",
    triggerNote: "Planned — sent when staff approves a partner application.",
    sampleVars: {
      business_name: "The Demo Tavern", partner_name: "Jordan Lee", portal_url: "https://partners.zapnivo.com",
      onboarding_url: "https://partners.zapnivo.com/onboarding", year: YEAR,
    },
    textVars: ["business_name", "partner_name", "portal_url", "onboarding_url"],
  },
  {
    name: "revenue_statement",
    displayName: "Revenue statement",
    audience: "Partners",
    subject: "Your {{month}} Zapnivo revenue statement",
    description: "Monthly commission statement for a partner venue.",
    triggerNote: "Planned — monthly statement job per venue (related: /api/admin/statements).",
    sampleVars: {
      venue_name: "The Demo Tavern — Downtown", month: "October 2026", gross: "$1,240.00",
      commission: "$310.00", statement_url: "https://partners.zapnivo.com/payouts", year: YEAR,
    },
    textVars: ["venue_name", "month", "gross", "commission", "statement_url"],
  },

  // ── Finance ──────────────────────────────────────────────────────────────
  {
    name: "payment_receipt",
    displayName: "Payment receipt",
    audience: "Finance",
    subject: "Your Zapnivo payment receipt",
    description: "Itemized receipt after a rental payment is captured.",
    triggerNote: "Sent when a rental payment is captured.",
    sampleVars: {
      receipt_id: "ZR-8F2KQ1", receipt_url: "https://zapnivo.com/rental/ZR-8F2KQ1", rental_id: "ZR-8F2KQ1",
      subtotal: "$12.00", tax: "Not applied", total_paid: "$12.00", year: YEAR,
    },
    textVars: ["receipt_id", "receipt_url", "rental_id", "subtotal", "tax", "total_paid"],
  },
  {
    name: "payment_failed",
    displayName: "Payment failed",
    audience: "Finance",
    subject: "Payment failed for your Zapnivo rental",
    description: "Tells a customer a rental charge failed and how to retry.",
    triggerNote: "Planned — sent when a rental charge or deposit capture fails.",
    sampleVars: {
      rental_id: "ZR-8F2KQ1", amount: "$12.00", rental_url: "https://zapnivo.com/rental/ZR-8F2KQ1",
      retry_url: "https://zapnivo.com/rental/ZR-8F2KQ1", year: YEAR,
    },
    textVars: ["rental_id", "amount", "rental_url", "retry_url"],
  },
  {
    name: "refund_processed",
    displayName: "Refund processed",
    audience: "Finance",
    subject: "Your Zapnivo refund was issued",
    description: "Confirms a refund was issued to the original payment method.",
    triggerNote: "Sent when a refund request is approved and issued.",
    sampleVars: {
      refund_amount: "$12.00", refund_id: "RF-9C41E2", refund_url: "https://support.zapnivo.com/ticket/ZN-1042",
      rental_id: "ZR-8F2KQ1", processed_at: "Nov 7, 2026", year: YEAR,
    },
    textVars: ["refund_amount", "refund_id", "refund_url", "rental_id", "processed_at"],
  },
  {
    name: "payment_dispute",
    displayName: "Payment dispute",
    audience: "Finance",
    subject: "A dispute was opened on your Zapnivo payment",
    description: "Notifies about a chargeback/dispute on a rental payment.",
    triggerNote: "Planned — sent when a Stripe dispute is opened (see /admin/disputes).",
    sampleVars: {
      rental_id: "ZR-8F2KQ1", amount: "$12.00", dispute_id: "DP-3A8F19",
      rental_url: "https://zapnivo.com/rental/ZR-8F2KQ1", year: YEAR,
    },
    textVars: ["rental_id", "amount", "dispute_id", "rental_url"],
  },

  // ── Support ──────────────────────────────────────────────────────────────
  {
    name: "support_created",
    displayName: "Support request received",
    audience: "Support",
    subject: "We received your Zapnivo support request",
    description: "Acknowledges a new helpdesk ticket with its reference number.",
    triggerNote: "Sent when a support ticket is created.",
    sampleVars: {
      ticket_id: "ZN-1042", ticket_subject: "Where can I return my charger?", ticket_status: "open",
      ticket_url: "https://support.zapnivo.com/ticket/ZN-1042?t=sample", created_at: "Nov 7, 2026, 9:14 AM", year: YEAR,
    },
    textVars: ["ticket_id", "ticket_subject", "ticket_status", "ticket_url", "created_at"],
  },
  {
    name: "support_updated",
    displayName: "Support ticket update",
    audience: "Support",
    subject: "Update on Zapnivo ticket {{ticket_id}}",
    description: "Sent when a ticket gets a new reply or status change.",
    triggerNote: "Sent on ticket replies and status changes.",
    sampleVars: {
      ticket_id: "ZN-1042", ticket_status: "in progress", ticket_subject: "Where can I return my charger?",
      ticket_url: "https://support.zapnivo.com/ticket/ZN-1042?t=sample", updated_at: "Nov 8, 2026, 10:02 AM", year: YEAR,
    },
    textVars: ["ticket_id", "ticket_status", "ticket_subject", "ticket_url", "updated_at"],
  },

  // ── Operations ───────────────────────────────────────────────────────────
  {
    name: "station_offline",
    displayName: "Station offline",
    audience: "Operations",
    subject: "Station offline: {{station_id}}",
    description: "Alerts staff/partners that a kiosk station stopped responding.",
    triggerNote: "Planned — sent by the fleet sweep when a station goes offline.",
    sampleVars: {
      station_id: "ZN-ST-042", station_name: "Kiosk 3 — Main St", venue_name: "The Demo Tavern — Downtown",
      since: "Nov 8, 2026, 6:45 AM", ops_url: "https://internal.zapnivo.com/admin/fleet", year: YEAR,
    },
    textVars: ["station_id", "station_name", "venue_name", "since", "ops_url"],
  },

  // ── Security ─────────────────────────────────────────────────────────────
  {
    name: "security_alert",
    displayName: "Security alert",
    audience: "Security",
    subject: "Security alert: {{alert_type}}",
    description: "Internal alert for suspicious account or payment activity.",
    triggerNote: "Planned — sent to staff on fraud/risk signals.",
    sampleVars: {
      alert_type: "Unusual login", detail: "Sign-in from a new country for admin@zapnivo.com",
      occurred_at: "Nov 8, 2026, 3:12 AM", account: "admin@zapnivo.com",
      review_url: "https://internal.zapnivo.com/admin/audit", year: YEAR,
    },
    textVars: ["alert_type", "detail", "occurred_at", "account", "review_url"],
  },
];

export const getEmailTemplate = (name: string): EmailTemplateSpec | undefined =>
  EMAIL_TEMPLATES.find((t) => t.name === name);

export const templatesByAudience = (): { audience: EmailAudience; templates: EmailTemplateSpec[] }[] =>
  EMAIL_AUDIENCES
    .map((audience) => ({ audience, templates: EMAIL_TEMPLATES.filter((t) => t.audience === audience) }))
    .filter((g) => g.templates.length > 0);

/* ── Safe rendering ──────────────────────────────────────────────────────── */

const render = renderEmail as unknown as (name: string, vars: Record<string, string>) => string;

/** Renders a subject line: {{var}} placeholders are replaced with raw (unescaped) values. */
export function renderSubject(subject: string, vars: Record<string, string>): string {
  let out = subject;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v);
  return out.replace(/{{[a-z_]+}}/g, "").trim();
}

export type StudioRender =
  | { available: true; html: string; subject: string; vars: string[] }
  | { available: false; error: string; vars: string[] };

/**
 * Renders a template for the studio. Never throws — unknown/incomplete templates
 * (renderEmail may lag the registry while other work lands) return available:false.
 */
export function renderStudioTemplate(spec: EmailTemplateSpec, vars: Record<string, string>): StudioRender {
  const varNames = Array.from(new Set([...Object.keys(spec.sampleVars), ...Object.keys(vars)])).sort();
  try {
    const html = render(spec.name, vars);
    return { available: true, html, subject: renderSubject(spec.subject, vars), vars: varNames };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : "render_failed", vars: varNames };
  }
}

/** Extracts {{var}} placeholders still present in rendered output or subject. */
export function extractTemplateVars(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(/{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g)).map((m) => m[1]))).sort();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™",
};

/**
 * Best-effort HTML → plain text for the studio's text tab. There is no dedicated
 * text renderer yet, so this derives readable text from the branded HTML —
 * honest fallback, not the production text part.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<\/(p|div|tr|table|h[1-6]|li|blockquote|section|header|footer|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => NAMED_ENTITIES[name] ?? m)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
