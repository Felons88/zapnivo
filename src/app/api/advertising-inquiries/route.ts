import { handleSubmission } from "@/lib/submit";
import { advertisingSchema } from "@/lib/validation";

export const POST = (req: Request) =>
  handleSubmission({
    req, schema: advertisingSchema, table: "advertising_inquiries", scope: "ads",
    map: (d) => ({ company_name: d.companyName, contact_name: d.contactName, email: d.email, phone: d.phone, goals: d.goals, budget: d.budget }),
  });
