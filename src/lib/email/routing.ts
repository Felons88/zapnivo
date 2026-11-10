import type { EmailSenderId } from "./senders";

/**
 * Registry of every business event that can produce an email, mapped to the
 * department sender, template, and recipient kind that should carry it.
 *
 * status:
 *  - "wired"    — a real code path currently queues this event
 *  - "planned"  — spec'd event, sender assigned, no send path yet (documents coverage, sends nothing)
 *  - "no_template" — code path exists but there is no designed template for it
 */
export type EmailTriggerStatus = "wired" | "planned" | "no_template";
export type RecipientKind = "customer" | "applicant" | "partner" | "staff";

export type EmailTriggerEntry = {
  sender: EmailSenderId;
  /** Template name in EMAIL_TEMPLATE_NAMES, or null when the event is text-only / not yet designed. */
  template: string | null;
  recipientKind: RecipientKind;
  description: string;
  status: EmailTriggerStatus;
};

export const EMAIL_TRIGGER_REGISTRY = {
  // ── Wired: support desk ──────────────────────────────────────────────
  "support.ticket.created": {
    sender: "support", template: "support_created", recipientKind: "customer",
    description: "Ticket created and an acknowledgement/auto-reply goes to the requester.", status: "wired",
  },
  "support.ticket.updated": {
    sender: "support", template: "support_updated", recipientKind: "customer",
    description: "Agent/system update notification on an existing ticket.", status: "wired",
  },
  "support.ticket.agent_reply": {
    sender: "support", template: "support_updated", recipientKind: "customer",
    description: "Agent reply delivered to the customer (same support_updated template).", status: "wired",
  },

  // ── Wired: rentals lifecycle ─────────────────────────────────────────
  "rental.started": {
    sender: "rentals", template: "rental_started", recipientKind: "customer",
    description: "Power bank dispensed — rental is active.", status: "wired",
  },
  "rental.returned": {
    sender: "rentals", template: "rental_returned", recipientKind: "customer",
    description: "Return confirmed at a station.", status: "wired",
  },
  "rental.reminder": {
    sender: "rentals", template: "rental_reminder", recipientKind: "customer",
    description: "Daily sweep reminder before the non-return deadline.", status: "wired",
  },
  "rental.nonreturn_notice": {
    sender: "rentals", template: "nonreturn_notice", recipientKind: "customer",
    description: "Overdue rental notice after the return deadline.", status: "wired",
  },
  "rental.payment_failed": {
    sender: "billing", template: "payment_failed", recipientKind: "customer",
    description: "Payment authorization failed; no bank released. Branded HTML via triggerPaymentFailedHtml; legacy text-only path also exists.", status: "wired",
  },

  // ── Wired: payments & billing ────────────────────────────────────────
  "payment.receipt": {
    sender: "billing", template: "payment_receipt", recipientKind: "customer",
    description: "Payment captured receipt for a rental.", status: "wired",
  },
  "payment.refund": {
    sender: "billing", template: "refund_processed", recipientKind: "customer",
    description: "Refund issued to the customer (sent from the helpdesk refund flow).", status: "wired",
  },

  // ── Wired: partners ──────────────────────────────────────────────────
  "partner.application.received": {
    sender: "partners", template: "partner_inquiry", recipientKind: "applicant",
    description: "Acknowledgement to the applicant that their inquiry was received.", status: "wired",
  },
  "partner.application.staff_alert": {
    sender: "partners", template: "partner_application_received", recipientKind: "staff",
    description: "Internal alert to staff/admin that a new application needs review.", status: "wired",
  },
  "partner.approved": {
    sender: "partners", template: "partner_approved", recipientKind: "applicant",
    description: "Welcome email after an application is approved.", status: "wired",
  },
  "partner.revenue_statement": {
    sender: "billing", template: "revenue_statement", recipientKind: "partner",
    description: "Monthly revenue statement to a partner organization.", status: "wired",
  },

  // ── Wired: operations & admin ────────────────────────────────────────
  "station.offline": {
    sender: "operations", template: "station_offline", recipientKind: "staff",
    description: "Station stopped reporting heartbeats; staff alerted.", status: "wired",
  },
  "station.restored": {
    sender: "operations", template: null, recipientKind: "staff",
    description: "Station came back online after an outage (no dedicated template yet).", status: "planned",
  },
  "payment.dispute.opened": {
    sender: "admin", template: "payment_dispute", recipientKind: "staff",
    description: "Stripe dispute opened — action required.", status: "wired",
  },
  "security.alert": {
    sender: "security", template: "security_alert", recipientKind: "staff",
    description: "Security monitoring alert to ops staff.", status: "wired",
  },
  "admin.cron_failed": {
    sender: "admin", template: null, recipientKind: "staff",
    description: "A cron job threw; staff alerted. Text-only by design.", status: "wired",
  },
  "station.low_battery": {
    sender: "operations", template: null, recipientKind: "staff",
    description: "Power bank below threshold — batched staff alert, no template.", status: "wired",
  },

  // ── Planned: not yet wired ───────────────────────────────────────────
  "account.welcome": {
    sender: "general", template: null, recipientKind: "customer",
    description: "New customer account welcome email (spec'd, no trigger yet).", status: "planned",
  },
  "account.password_reset": {
    sender: "security", template: null, recipientKind: "customer",
    description: "Password reset / OTP email (spec'd, no trigger yet).", status: "planned",
  },
  "agreement.signed": {
    sender: "legal", template: null, recipientKind: "partner",
    description: "Partner agreement countersigned confirmation (spec'd).", status: "planned",
  },
  "partner.payout_initiated": {
    sender: "billing", template: null, recipientKind: "partner",
    description: "Payout run started for a partner (spec'd).", status: "planned",
  },
  "partner.payout_completed": {
    sender: "billing", template: null, recipientKind: "partner",
    description: "Payout completed (spec'd).", status: "planned",
  },
  "partner.payout_failed": {
    sender: "billing", template: null, recipientKind: "partner",
    description: "Payout failed — needs attention (spec'd).", status: "planned",
  },
  "station.maintenance": {
    sender: "operations", template: null, recipientKind: "staff",
    description: "Scheduled maintenance notice for a station (spec'd).", status: "planned",
  },
  "contact.inquiry": {
    sender: "general", template: null, recipientKind: "customer",
    description: "General contact form acknowledgement — no dedicated template exists yet.", status: "no_template",
  },
} as const satisfies Record<string, EmailTriggerEntry>;

export type EmailTriggerEvent = keyof typeof EMAIL_TRIGGER_REGISTRY;
