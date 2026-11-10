import { z } from "zod";

const clean = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) =>
  z.string().trim().max(max).optional().transform((v) => v || undefined);
const email = z.string().trim().toLowerCase().email().max(254);
const phone = z
  .string()
  .trim()
  .regex(/^[+()\-.\s\d]{7,20}$/, "Enter a valid phone number");

/** Honeypot field: real users leave it empty. */
const honeypot = z.string().max(0).optional();

export const VENUE_TYPES = [
  "Bar", "Restaurant", "Hotel", "Shopping center", "University", "Event venue", "Entertainment venue", "Other",
] as const;

export const partnerApplicationSchema = z.object({
  businessName: clean(120),
  contactName: clean(120),
  email,
  phone,
  venueType: z.enum(VENUE_TYPES),
  street: clean(160),
  city: clean(80),
  state: z.string().trim().length(2).toUpperCase(),
  hours: optional(200),
  guestTraffic: optional(100),
  installLocation: optional(300),
  questions: optional(2000),
  website: honeypot,
});

export const ADS_BUDGETS = ["Not sure yet", "Under $500/mo", "$500-$2,000/mo", "$2,000+/mo"] as const;

export const advertisingSchema = z.object({
  companyName: clean(120),
  contactName: clean(120),
  email,
  phone: z.union([phone, z.literal("")]).optional().transform((v) => v || undefined),
  goals: clean(2000),
  budget: z.enum(ADS_BUDGETS).optional(),
  website: honeypot,
});

export const CONTACT_TOPICS = ["partnerships", "support", "general", "advertising"] as const;

export const contactSchema = z.object({
  topic: z.enum(CONTACT_TOPICS),
  name: clean(120),
  email,
  message: clean(3000),
  website: honeypot,
});

export const TICKET_CATEGORIES = [
  "Charger did not dispense", "Return not recognized", "Billing question", "Damaged charger", "Refund request", "Accessibility assistance", "Other",
] as const;

export const ticketSchema = z.object({
  name: clean(120),
  email,
  phone: z.union([phone, z.literal("")]).optional().transform((v) => v || undefined),
  rentalRef: optional(60),
  station: optional(160),
  category: z.enum(TICKET_CATEGORIES),
  description: z.string().trim().min(10).max(4000),
  consent: z.literal(true, { message: "Consent to the privacy disclosure is required" }),
  website: honeypot,
});

const iso = z.string().datetime({ offset: true });
const HOURS_48 = 48 * 3600_000;

/** Rental lookup: email AND (reference OR a ≤48h date window). Email must match the receipt email. */
export const rentalLookupSchema = z
  .object({
    email,
    reference: z.string().trim().toUpperCase().regex(/^ZR-[A-Z0-9]{8}$/, "Enter a reference like ZR-1A2B3C4D").optional(),
    station: optional(160),
    from: iso.optional(),
    to: iso.optional(),
  })
  .refine((d) => d.reference || (d.from && d.to), { message: "Enter a rental reference, or a date to search by." })
  .refine((d) => !d.from || !d.to || (Date.parse(d.to) >= Date.parse(d.from) && Date.parse(d.to) - Date.parse(d.from) <= HOURS_48), { message: "That date range is too wide." });

export const ticketStatusSchema = z.object({
  ticketNumber: z.string().trim().toUpperCase().regex(/^Z-\d{3,9}$/, "Enter a ticket number like Z-1001"),
  email,
});

/** Rejects text that looks like a payment card number so customers don't send one by mistake. */
export const looksLikeCardNumber = (s: string) => /\b(?:\d[ -]?){13,19}\b/.test(s);

export const ALLOWED_UPLOADS = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type PartnerApplication = z.infer<typeof partnerApplicationSchema>;
export type TicketInput = z.infer<typeof ticketSchema>;
