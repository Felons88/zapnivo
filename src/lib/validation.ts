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

/** Vending product categories a venue partner can express interest in (comma-joined in `productInterest`). */
export const PRODUCT_INTEREST_KEYS = [
  "snack", "beverage", "food", "phone_charger", "trading_cards", "specialty", "custom",
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
  productInterest: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((v) => v || undefined)
    .refine(
      (v) => v === undefined || v.split(",").every((k) => (PRODUCT_INTEREST_KEYS as readonly string[]).includes(k.trim())),
      "Select valid product interests",
    ),
  website: honeypot,
});

/* ---------- Vending / equipment inquiries (partner_applications pipeline) ---------- */

export const VENDING_PRODUCT_INTERESTS = [
  "snack", "beverage", "food", "phone_charger", "trading_cards",
  "specialty", "custom", "equipment_purchase", "general",
] as const;
export type VendingProductInterest = (typeof VENDING_PRODUCT_INTERESTS)[number];

export const VENDING_PRODUCT_LABELS: Record<VendingProductInterest, string> = {
  snack: "Snacks & vending machines",
  beverage: "Beverages",
  food: "Food & fresh",
  phone_charger: "Phone charging",
  trading_cards: "Trading cards & collectibles",
  specialty: "Specialty / curated",
  custom: "Custom package",
  equipment_purchase: "Equipment purchase",
  general: "General inquiry",
};

export const VENDING_VENUE_CATEGORIES = [
  "bar_restaurant", "hotel", "apartment", "office", "warehouse",
  "shopping_center", "entertainment", "college", "recreation",
  "event_venue", "retail", "community_space", "other",
] as const;
export type VendingVenueCategory = (typeof VENDING_VENUE_CATEGORIES)[number];

/** Human-readable venue_type stored on partner_applications rows. */
export const VENDING_VENUE_LABELS: Record<VendingVenueCategory, string> = {
  bar_restaurant: "Bar / restaurant",
  hotel: "Hotel",
  apartment: "Apartment / residential",
  office: "Office",
  warehouse: "Warehouse / industrial",
  shopping_center: "Shopping center",
  entertainment: "Entertainment venue",
  college: "College / university",
  recreation: "Recreation / fitness",
  event_venue: "Event venue",
  retail: "Retail store",
  community_space: "Community space",
  other: "Other",
};

export const VENDING_TRAFFIC_OPTIONS = ["<50", "50-200", "200-1000", "1000+"] as const;
export type VendingTraffic = (typeof VENDING_TRAFFIC_OPTIONS)[number];

export const VENDING_TRAFFIC_LABELS: Record<VendingTraffic, string> = {
  "<50": "Under 50 guests/day",
  "50-200": "50–200 guests/day",
  "200-1000": "200–1,000 guests/day",
  "1000+": "1,000+ guests/day",
};

export const VENDING_TIMELINES = ["asap", "1-3mo", "3-6mo", "6mo+", "exploring"] as const;
export type VendingTimeline = (typeof VENDING_TIMELINES)[number];

export const VENDING_TIMELINE_LABELS: Record<VendingTimeline, string> = {
  asap: "As soon as possible",
  "1-3mo": "1–3 months",
  "3-6mo": "3–6 months",
  "6mo+": "6+ months",
  exploring: "Just exploring",
};

/** Accepts a single key or a comma-joined list; output is always a normalized comma-joined string. */
const vendingProductInterest = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(z.enum(VENDING_PRODUCT_INTERESTS)).min(1).max(VENDING_PRODUCT_INTERESTS.length))
  .transform((arr) => arr.join(","));

export const vendingInquirySchema = z.object({
  businessName: clean(120),
  contactName: clean(120),
  email,
  phone,
  address: clean(160),
  city: clean(80),
  state: z.string().trim().length(2).toUpperCase(),
  venueCategory: z.enum(VENDING_VENUE_CATEGORIES),
  guestTraffic: z.union([z.enum(VENDING_TRAFFIC_OPTIONS), z.literal("")]).optional().transform((v) => v || undefined),
  productInterest: vendingProductInterest,
  spaceNotes: optional(2000),
  timeline: z.union([z.enum(VENDING_TIMELINES), z.literal("")]).optional().transform((v) => v || undefined),
  questions: optional(2000),
  source: optional(80),
  consent: z.literal(true, { message: "Consent to the privacy disclosure is required" }),
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
export type VendingInquiry = z.infer<typeof vendingInquirySchema>;
export type TicketInput = z.infer<typeof ticketSchema>;
