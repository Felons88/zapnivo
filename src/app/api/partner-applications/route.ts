import { renderEmail } from "@/lib/email-templates";
import { triggerPartnerApplicationReceived } from "@/lib/email-extra-triggers";
import { flushOutbox, getMailer } from "@/lib/helpdesk/mailer";
import { getRepo } from "@/lib/helpdesk/repo";
import { serviceClient } from "@/lib/supabase";
import { handleSubmission } from "@/lib/submit";
import { partnerApplicationSchema } from "@/lib/validation";

export const POST = (req: Request) =>
  handleSubmission({
    req, schema: partnerApplicationSchema, table: "partner_applications", scope: "partner",
    map: (d) => ({
      business_name: d.businessName, contact_name: d.contactName, email: d.email, phone: d.phone,
      venue_type: d.venueType, street: d.street, city: d.city, state: d.state, hours: d.hours,
      guest_traffic: d.guestTraffic, install_location: d.installLocation, questions: d.questions,
    }),
    after: async (d, row) => {
      const repo = await getRepo();
      if (!repo) return;
      await repo.queueEmail({
        ticketId: null, to: d.email,
        subject: "We received your Zapnivo partnership inquiry",
        body: `Hi ${d.contactName},\n\nThanks for reaching out about hosting a Zapnivo station at ${d.businessName} in ${d.city}, ${d.state}. We've logged your inquiry (${row.id.slice(0, 8).toUpperCase()}) and will be in touch to schedule a consultation.\n\n— Zapnivo Team`,
        html: renderEmail("partner_inquiry", {
          business_name: d.businessName, contact_name: d.contactName,
          business_location: `${d.city}, ${d.state}`, inquiry_id: row.id.slice(0, 8).toUpperCase(),
          year: String(new Date().getFullYear()),
        }),
        sender: "partners", replyTo: null, template: "partner_inquiry", event: "partner.application.received",
      });
      await flushOutbox(repo, getMailer());
      const db = serviceClient();
      if (db) {
        const { data: staff } = await db.from("profiles").select("email").in("role", ["admin", "staff"]).limit(50);
        const app = {
          contactName: d.contactName, businessName: d.businessName,
          businessLocation: `${d.city}, ${d.state}`, inquiryId: row.id.slice(0, 8).toUpperCase(),
        };
        for (const s of (staff ?? []) as { email: string }[]) await triggerPartnerApplicationReceived(s.email, app).catch(() => false);
      }
    },
  });
