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
  });
