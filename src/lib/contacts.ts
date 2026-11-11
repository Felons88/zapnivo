import { EMAIL_SENDERS, type EmailSenderId } from "./email/senders";

/**
 * Single verified contact registry for the public site.
 *
 * Every address here is derived from EMAIL_SENDERS — the same registry outbound
 * mail resolves its From/Reply-To through — so a "contact" can never drift away
 * from a real sender identity. No other file should hardcode @zapnivo.com
 * addresses; import CONTACTS / isPublicContact instead.
 *
 * Honesty notes for the scam-awareness page:
 * - `outboundSender`: Zapnivo sends mail *from* this address.
 * - `monitored`: a human team reads replies sent *to* this address.
 *   (Automated system mail may also come from noreply@zapnivo.com, which is an
 *   outbound sender only and deliberately NOT listed here as a contact.)
 */
export type ContactKind = "public_contact" | "support" | "partnership" | "billing" | "security";

export type ContactEntry = {
  /** Sender id in EMAIL_SENDERS this entry is verified against. */
  senderId: EmailSenderId;
  email: string;
  label: string;
  description: string;
  kind: ContactKind;
  /** True when Zapnivo sends outbound mail from this address. */
  outboundSender: boolean;
  /** True when replies to this address are read by the team. */
  monitored: boolean;
};

const entry = (
  senderId: EmailSenderId,
  label: string,
  description: string,
  kind: ContactKind,
): ContactEntry => ({
  senderId,
  // Structural guarantee: the address can only ever be one that exists in EMAIL_SENDERS.
  email: EMAIL_SENDERS[senderId].email,
  label,
  description,
  kind,
  outboundSender: true,
  monitored: true,
});

export const CONTACTS = {
  general: entry("general", "General inquiries", "Questions about Zapnivo, rentals, or anything that doesn't fit another inbox.", "public_contact"),
  support: entry("support", "Customer support", "Rental, return, billing, and account help — our main support inbox.", "support"),
  partners: entry("partners", "Partnerships", "Venue hosting, advertising, and business partnership conversations.", "partnership"),
  billing: entry("billing", "Billing", "Payment receipts, charges, refunds, and invoicing questions.", "billing"),
  security: entry("security", "Security & abuse reports", "Suspected phishing, fraud, or security concerns involving Zapnivo.", "security"),
} as const;

export type ContactKey = keyof typeof CONTACTS;

/** Case-insensitive membership check against the verified registry. */
export function isPublicContact(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return Object.values(CONTACTS).some((c) => c.email === normalized);
}
