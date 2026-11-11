import { z } from "zod";

/**
 * Public scam/fraud report intake (/scam-awareness/report → POST /api/scam-reports).
 *
 * Storage decision: there is no dedicated scam_reports table and migrations are
 * owned elsewhere, so reports are stored in the existing `contact_messages`
 * pipeline with queue='general' and a structured `kind: scam_report` header in
 * the message body (the queue CHECK constraint can't take a new value without a
 * migration). contact_messages.email is NOT NULL, so reporters who don't share
 * an email are stored under REPORT_ANON_EMAIL — a sentinel, never a real inbox.
 */
export const SCAM_CATEGORIES = [
  "suspicious_email",
  "suspicious_sms",
  "fake_website",
  "fake_representative",
  "suspicious_qr",
  "payment_request",
  "other",
] as const;
export type ScamCategory = (typeof SCAM_CATEGORIES)[number];

export const REPORT_KIND = "scam_report";

/** Sentinel stored in contact_messages.email when the reporter shares none. */
export const REPORT_ANON_EMAIL = "not-provided@zapnivo.com";

const blankToUndef = (max: number) =>
  z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "Enter a valid date");

/** Honeypot: real users leave `website` empty; anything else is a bot. */
const honeypot = z.string().max(0).optional();

export const scamReportSchema = z.object({
  category: z.enum(SCAM_CATEGORIES),
  description: z.string().trim().min(10, "Please describe what happened.").max(4000),
  sender_or_url: blankToUndef(500),
  occurred_on: blankToUndef(10).pipe(z.union([isoDate, z.undefined()]).optional()),
  contact_email: blankToUndef(254)
    .pipe(z.union([z.string().trim().toLowerCase().email().max(254), z.undefined()]).optional()),
  station_id: blankToUndef(80),
  website: honeypot,
});

export type ScamReport = z.infer<typeof scamReportSchema>;

const CATEGORY_LABEL: Record<ScamCategory, string> = {
  suspicious_email: "Suspicious email",
  suspicious_sms: "Suspicious text (SMS)",
  fake_website: "Fake website or link",
  fake_representative: "Fake Zapnivo employee or partner",
  suspicious_qr: "Tampered kiosk QR code",
  payment_request: "Fake payment request",
  other: "Something else",
};

/** Renders the structured header + body stored in contact_messages.message. */
export function formatReportMessage(d: ScamReport): string {
  const lines = [
    `[kind: ${REPORT_KIND}]`,
    `category: ${d.category} (${CATEGORY_LABEL[d.category]})`,
  ];
  if (d.occurred_on) lines.push(`occurred_on: ${d.occurred_on}`);
  if (d.sender_or_url) lines.push(`sender_or_url: ${d.sender_or_url}`);
  if (d.station_id) lines.push(`station_id: ${d.station_id}`);
  if (d.contact_email) lines.push(`contact_email: ${d.contact_email}`);
  lines.push("---", d.description);
  return lines.join("\n");
}
