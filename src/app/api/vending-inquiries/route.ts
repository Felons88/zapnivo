import { trackServer } from "@/lib/analytics";
import { renderEmail } from "@/lib/email-templates";
import { triggerVendingInquiryReceived } from "@/lib/email-extra-triggers";
import { flushOutbox, getMailer } from "@/lib/helpdesk/mailer";
import { getRepo } from "@/lib/helpdesk/repo";
import { recordLog } from "@/lib/observability";
import { serviceClient } from "@/lib/supabase";
import { handleSubmission } from "@/lib/submit";
import {
  VENDING_PRODUCT_LABELS,
  VENDING_TIMELINE_LABELS,
  VENDING_TRAFFIC_LABELS,
  VENDING_VENUE_LABELS,
  vendingInquirySchema,
} from "@/lib/validation";

const productLabel = (csv: string) =>
  csv.split(",").map((k) => VENDING_PRODUCT_LABELS[k as keyof typeof VENDING_PRODUCT_LABELS] ?? k).join(", ");

/**
 * Public vending / equipment-sales inquiry. Lands in partner_applications
 * (same CRM pipeline as venue applications) with the vending-specific columns
 * from migration 0070: product_interest, space_notes, timeline.
 */
export const POST = (req: Request) =>
  handleSubmission({
    req, schema: vendingInquirySchema, table: "partner_applications", scope: "vending-inquiry",
    map: (d) => ({
      business_name: d.businessName,
      contact_name: d.contactName,
      email: d.email,
      phone: d.phone,
      venue_type: VENDING_VENUE_LABELS[d.venueCategory],
      street: d.address,
      city: d.city,
      state: d.state,
      guest_traffic: d.guestTraffic ? VENDING_TRAFFIC_LABELS[d.guestTraffic] ?? d.guestTraffic : undefined,
      product_interest: d.productInterest,
      space_notes: d.spaceNotes,
      timeline: d.timeline ? VENDING_TIMELINE_LABELS[d.timeline] ?? d.timeline : undefined,
      questions: d.questions,
      lead_source: d.source,
    }),
    after: async (d, row) => {
      recordLog("info", "vending_inquiry_submitted", { service: "partners", route: "vending-inquiries", attrs: { applicationId: row.id, venueCategory: d.venueCategory, productInterest: d.productInterest } });
      trackServer({
        name: "partner_application_submitted",
        entityType: "partner_application",
        entityId: row.id,
        props: { venue_category: d.venueCategory, product_interest: d.productInterest.split(",")[0] },
      });
      const repo = await getRepo();
      if (!repo) return;
      const inquiryId = row.id.slice(0, 8).toUpperCase();
      await repo.queueEmail({
        ticketId: null, to: d.email,
        subject: "We received your Zapnivo vending inquiry",
        body: `Hi ${d.contactName},\n\nThanks for your interest in Zapnivo vending and equipment for ${d.businessName} in ${d.city}, ${d.state}. We've logged your inquiry (${inquiryId}) and will be in touch to talk through options.\n\n— Zapnivo Team`,
        html: renderEmail("vending_inquiry_received", {
          business_name: d.businessName, contact_name: d.contactName,
          business_location: `${d.city}, ${d.state}`, product_interest: productLabel(d.productInterest),
          inquiry_id: inquiryId, year: String(new Date().getFullYear()),
        }),
        sender: "partners", replyTo: null, template: "vending_inquiry_received", event: "vending.inquiry.received",
      });
      await flushOutbox(repo, getMailer());
      const db = serviceClient();
      if (db) {
        const { data: staff } = await db.from("profiles").select("email").in("role", ["admin", "staff"]).limit(50);
        const app = {
          contactName: d.contactName, businessName: d.businessName,
          businessLocation: `${d.city}, ${d.state} · ${productLabel(d.productInterest)}`,
          inquiryId,
        };
        for (const s of (staff ?? []) as { email: string }[]) await triggerVendingInquiryReceived(s.email, app).catch(() => false);
      }
    },
  });
