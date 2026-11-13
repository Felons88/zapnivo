import { alertStaff } from "@/lib/email-triggers";
import { recordLog } from "@/lib/observability";
import { handleSubmission } from "@/lib/submit";
import { contactSchema } from "@/lib/validation";

const QUEUE = { partnerships: "venue_partnerships", support: "customer_support", general: "general", advertising: "advertising" } as const;
const TOPIC_LABEL = { partnerships: "Partnership / venue", support: "Customer support", general: "General", advertising: "Advertising" } as const;

export const POST = (req: Request) =>
  handleSubmission({
    req, schema: contactSchema, table: "contact_messages", scope: "contact",
    map: (d) => ({ queue: QUEUE[d.topic], name: d.name, email: d.email, message: d.message }),
    after: async (d, row) => {
      recordLog("info", "contact_message_submitted", { service: "contact", route: "contact", attrs: { id: row.id, topic: d.topic } });
      // Staff notification via the outbox (queued honestly — no template exists
      // for contact.inquiry yet, so this is plain text). Never fails the form.
      await alertStaff({
        subject: `New Zapnivo contact message — ${TOPIC_LABEL[d.topic]}`,
        body: [
          `Topic: ${TOPIC_LABEL[d.topic]} (${d.topic})`,
          `From: ${d.name} <${d.email}>`,
          `Submission id: ${row.id}`,
          ``,
          d.message,
          ``,
          `— Zapnivo website contact form`,
        ].join("\n"),
        sender: "general",
        event: "contact.inquiry.staff_alert",
      });
    },
  });
