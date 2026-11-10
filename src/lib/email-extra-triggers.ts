import { renderEmail, renderEmailText } from "./email-templates";
import { emailFor, loadRental, rentalUrl, sendToCustomer, stamp, year } from "./email-triggers";
import { queueJob } from "./notifications";
import { serviceClient } from "./supabase";
import { subUrl } from "./site";

/**
 * Triggers for the second wave of branded email templates (payment_failed,
 * partner_*, revenue_statement, station_offline, payment_dispute, security_alert).
 * Same delivery path as email-triggers.ts: queue into the helpdesk outbox, then flush.
 */

const adminUrl = () => subUrl("internal", "/");
const partnerPortalUrl = () => subUrl("partners", "/");

const send = (to: string, subject: string, name: Parameters<typeof renderEmail>[0], vars: Record<string, string>) =>
  sendToCustomer(to, subject, renderEmailText(name, vars), renderEmail(name, vars));

/**
 * Branded HTML version of the failed-payment email. The legacy `triggerPaymentFailed`
 * in ./email-triggers still sends plain-text only — swap its call site to this once
 * the admin preview studio / lead wiring is ready. Keeps the same SMS queue job.
 */
export async function triggerPaymentFailedHtml(rentalId: string) {
  const r = await loadRental({ id: rentalId });
  const db0 = serviceClient();
  if (db0) await queueJob(db0, { kind: "payment_failed", rentalId }).catch(() => false);
  const to = r && emailFor(r);
  if (!r || !to) return false;
  return send(to, "Your Zapnivo payment didn't go through", "payment_failed", {
    rental_id: r.reference,
    venue_name: r.kiosks?.venues?.name ?? r.kiosks?.station_id ?? "Zapnivo station",
    rental_url: rentalUrl(),
    year: year(),
  });
}

export type PartnerApplicationFields = {
  contactName: string;
  businessName: string;
  businessLocation: string;
  inquiryId: string;
  submittedAt?: string;
};

/** Admin/ops alert: a new partner application needs review. */
export async function triggerPartnerApplicationReceived(adminEmail: string, app: PartnerApplicationFields) {
  return send(adminEmail, `New Zapnivo partner application — ${app.businessName}`, "partner_application_received", {
    contact_name: app.contactName,
    business_name: app.businessName,
    business_location: app.businessLocation,
    inquiry_id: app.inquiryId,
    submitted_at: app.submittedAt ?? stamp(new Date().toISOString()),
    admin_url: adminUrl(),
    year: year(),
  });
}

/** Partner welcome email after an application is approved. */
export async function triggerPartnerApproved(email: string, orgName: string) {
  return send(email, `Welcome to Zapnivo, ${orgName}`, "partner_approved", {
    org_name: orgName,
    portal_url: partnerPortalUrl(),
    year: year(),
  });
}

/**
 * Monthly partner revenue statement. ALL figures must be pre-formatted display
 * strings — the template never computes money. `payoutDate` renders as the
 * "Net payout · <date>" label; pass an empty string when unknown.
 */
export type RevenueStatementVars = {
  orgName: string;
  period: string;          // e.g. "March 2026"
  rentalsCount: string;
  grossAmount: string;
  refundsAmount: string;
  revenueShare: string;
  netAmount: string;
  payoutStatus: string;    // e.g. "Paid", "Scheduled", "Pending"
  payoutDate?: string;     // e.g. "paid Mar 31" — optional
  portalUrl?: string;      // defaults to the partners portal
};

export async function triggerRevenueStatement(email: string, s: RevenueStatementVars) {
  return send(email, `Zapnivo revenue statement — ${s.period}`, "revenue_statement", {
    org_name: s.orgName,
    period: s.period,
    rentals_count: s.rentalsCount,
    gross_amount: s.grossAmount,
    refunds_amount: s.refundsAmount,
    revenue_share: s.revenueShare,
    net_amount: s.netAmount,
    payout_status: s.payoutStatus,
    payout_date: s.payoutDate ?? "",
    portal_url: s.portalUrl ?? partnerPortalUrl(),
    year: year(),
  });
}

export type StationOfflineFields = {
  stationId: string;
  stationName: string;
  venueName: string;
  city: string;
  detectedAt?: string;
};

/** Admin/ops HIGH-severity alert: a station stopped reporting. */
export async function triggerStationOffline(email: string, st: StationOfflineFields) {
  return send(email, `Zapnivo station offline — ${st.stationId}`, "station_offline", {
    station_id: st.stationId,
    station_name: st.stationName,
    venue_name: st.venueName,
    city: st.city,
    detected_at: st.detectedAt ?? stamp(new Date().toISOString()),
    admin_url: adminUrl(),
    year: year(),
  });
}

export type PaymentDisputeFields = {
  disputeId: string;
  amount: string;
  rentalRef: string;
  customerEmail: string;
  reason: string;
  openedAt?: string;
  respondBy?: string;
};

/** Admin/ops ACTION REQUIRED alert: a Stripe dispute needs a response. */
export async function triggerPaymentDispute(adminEmail: string, d: PaymentDisputeFields) {
  return send(adminEmail, `Payment dispute — action required (${d.disputeId})`, "payment_dispute", {
    dispute_id: d.disputeId,
    amount: d.amount,
    rental_ref: d.rentalRef,
    customer_email: d.customerEmail,
    reason: d.reason,
    opened_at: d.openedAt ?? stamp(new Date().toISOString()),
    respond_by: d.respondBy ?? "see Stripe dashboard",
    admin_url: adminUrl(),
    year: year(),
  });
}

export type SecurityAlertFields = {
  severity: string;       // e.g. "HIGH", "MEDIUM", "LOW"
  alertType: string;      // e.g. "Repeated failed logins"
  accountRef?: string;
  sourceRef?: string;     // e.g. IP or device fingerprint
  occurredAt?: string;
  details?: string;
};

/** Admin/ops generic severity-templated security notice. */
export async function triggerSecurityAlert(adminEmail: string, a: SecurityAlertFields) {
  return send(adminEmail, `Security alert (${a.severity}) — ${a.alertType}`, "security_alert", {
    severity: a.severity,
    alert_type: a.alertType,
    account_ref: a.accountRef ?? "—",
    source_ref: a.sourceRef ?? "—",
    occurred_at: a.occurredAt ?? stamp(new Date().toISOString()),
    details: a.details ?? "No additional details provided.",
    admin_url: adminUrl(),
    year: year(),
  });
}
