import { partnerApplicationSchema } from "@/lib/validation";

/**
 * Client-safe helpers for the partner application form.
 * Validation mirrors `partnerApplicationSchema` (src/lib/validation.ts) — the
 * server remains authoritative; this only gives faster, clearer inline feedback.
 * The `website` honeypot is excluded from client checks so bots get the same
 * silent treatment the API gives them.
 */

export const APPLICATION_SCHEMA = partnerApplicationSchema.omit({ website: true });

/** Field names grouped by wizard step. Must cover every schema key except the honeypot. */
export const STEP_FIELDS = [
  ["businessName", "contactName", "email", "phone"],
  ["venueType", "street", "city", "state"],
  ["hours", "guestTraffic", "installLocation", "questions"],
] as const;

export type StepField = (typeof STEP_FIELDS)[number][number];

export type FieldErrors = Partial<Record<string, string>>;

/** Zod schemas scoped to each step, for per-step "Continue" validation. */
export const STEP_SCHEMAS = [
  APPLICATION_SCHEMA.pick({ businessName: true, contactName: true, email: true, phone: true }),
  APPLICATION_SCHEMA.pick({ venueType: true, street: true, city: true, state: true }),
  APPLICATION_SCHEMA.pick({ hours: true, guestTraffic: true, installLocation: true, questions: true }),
] as const;

/** Wizard step labels shown to applicants. */
export const STEP_LABELS = ["Business", "Location", "Details"] as const;

/**
 * What the applicant can expect after submitting. Keep this honest: an
 * application is a conversation starter, not a placement guarantee.
 */
export const NEXT_STEPS = [
  {
    title: "We confirm receipt",
    body: "You'll get an email acknowledging your application with a reference number.",
  },
  {
    title: "We review your space",
    body: "Our team looks at your venue type, location, and likely placement before reaching out.",
  },
  {
    title: "We schedule a consultation",
    body: "If there's a fit, we'll set up a call to talk placement, timing, and partnership terms.",
  },
  {
    title: "Terms go in writing",
    body: "Anything agreed — including revenue share where offered — is documented in a partnership agreement before installation.",
  },
] as const;

/** Who is responsible for what, stated conservatively from existing site copy. */
export const RESPONSIBILITIES = [
  { who: "Zapnivo", items: "Supplies and installs the kiosk, manages the power banks, software, maintenance, and rental support." },
  { who: "Your venue", items: "Provides a visible, practical spot for the station and helps us plan placement around your operation." },
] as const;

/** Guest-facing rental facts (confirmed pricing) — context for venue partners. */
export const GUEST_RENTAL_FACTS = [
  "$6.99 per started hour",
  "24-hour return window",
  "$45 non-return fee",
] as const;

/** Flatten FormData-style string records into the shape the schema expects. */
export function toApplicationInput(data: Record<string, string>) {
  return {
    businessName: data.businessName ?? "",
    contactName: data.contactName ?? "",
    email: data.email ?? "",
    phone: data.phone ?? "",
    venueType: data.venueType ?? "",
    street: data.street ?? "",
    city: data.city ?? "",
    state: data.state ?? "",
    hours: data.hours ?? "",
    guestTraffic: data.guestTraffic ?? "",
    installLocation: data.installLocation ?? "",
    questions: data.questions ?? "",
  };
}

/** Map zod issues to first-message-per-field. */
function issuesToErrors(error: { issues: { path: PropertyKey[]; message: string }[] }): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "");
    if (field && !errors[field]) errors[field] = issue.message;
  }
  return errors;
}

/** Validate a single wizard step. Returns field errors, or null when the step is valid. */
export function validateStep(data: Record<string, string>, step: number): FieldErrors | null {
  const schema = STEP_SCHEMAS[step];
  if (!schema) return null;
  const result = schema.safeParse(toApplicationInput(data));
  if (result.success) return null;
  return issuesToErrors(result.error);
}

/**
 * Validate the full application client-side.
 * Returns field errors plus the wizard step containing the first invalid field,
 * so the form can jump the applicant back to what needs fixing.
 */
export function validateApplication(data: Record<string, string>): { errors: FieldErrors; step: number } {
  const result = APPLICATION_SCHEMA.safeParse(toApplicationInput(data));
  if (result.success) return { errors: {}, step: -1 };
  const errors = issuesToErrors(result.error);
  const fields = new Set(Object.keys(errors));
  const step = STEP_FIELDS.findIndex((group) => group.some((f) => fields.has(f)));
  return { errors, step: step >= 0 ? step : STEP_FIELDS.length - 1 };
}
