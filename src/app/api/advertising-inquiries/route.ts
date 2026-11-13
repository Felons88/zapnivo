import { alertStaff } from "@/lib/email-triggers";
import { recordLog } from "@/lib/observability";
import { handleSubmission } from "@/lib/submit";
import { advertisingSchema } from "@/lib/validation";

export const POST = (req: Request) =>
  handleSubmission({
    req, schema: advertisingSchema, table: "advertising_inquiries", scope: "ads",
    map: (d) => ({ company_name: d.companyName, contact_name: d.contactName, email: d.email, phone: d.phone, goals: d.goals, budget: d.budget }),
    after: async (d, row) => {
      recordLog("info", "advertising_inquiry_submitted", { service: "ads", route: "advertising-inquiries", attrs: { id: row.id } });
      // Staff notification via the outbox — partnerships owns advertising
      // conversations. Queued honestly; never fails the submission.
      await alertStaff({
        subject: `New Zapnivo advertising inquiry — ${d.companyName}`,
        body: [
          `Company: ${d.companyName}`,
          `Contact: ${d.contactName} <${d.email}>`,
          `Phone: ${d.phone ?? "—"}`,
          `Budget: ${d.budget ?? "—"}`,
          `Submission id: ${row.id}`,
          ``,
          `Goals:`,
          d.goals,
          ``,
          `— Zapnivo advertising form`,
        ].join("\n"),
        sender: "partners",
        event: "advertising.inquiry.staff_alert",
      });
    },
  });
