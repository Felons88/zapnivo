import { handleSubmission } from "@/lib/submit";
import { contactSchema } from "@/lib/validation";

const QUEUE = { partnerships: "venue_partnerships", support: "customer_support", general: "general", advertising: "advertising" } as const;

export const POST = (req: Request) =>
  handleSubmission({
    req, schema: contactSchema, table: "contact_messages", scope: "contact",
    map: (d) => ({ queue: QUEUE[d.topic], name: d.name, email: d.email, message: d.message }),
  });
