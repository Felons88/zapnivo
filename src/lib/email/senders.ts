/**
 * Per-department sender identities. Every outbound email resolves its From/Reply-To
 * through this registry instead of a single SUPPORT_FROM_EMAIL address.
 *
 * `email` is the From address; `replyTo` is where customer replies should land
 * (often the support inbox even for departmental senders like rentals/notifications/noreply).
 */
export type EmailSenderId =
  | "general" | "support" | "partners" | "rentals" | "billing" | "notifications"
  | "security" | "operations" | "legal" | "admin" | "noreply";

export const EMAIL_SENDERS: Record<EmailSenderId, { name: string; email: string; replyTo: string }> = {
  general:       { name: "Zapnivo Team",           email: "hello@zapnivo.com",        replyTo: "hello@zapnivo.com" },
  support:       { name: "Zapnivo Customer Care",  email: "support@zapnivo.com",      replyTo: "support@zapnivo.com" },
  partners:      { name: "Zapnivo Partnerships",   email: "partners@zapnivo.com",     replyTo: "partners@zapnivo.com" },
  rentals:       { name: "Zapnivo Rentals",        email: "rentals@zapnivo.com",      replyTo: "support@zapnivo.com" },
  billing:       { name: "Zapnivo Billing",        email: "billing@zapnivo.com",      replyTo: "billing@zapnivo.com" },
  notifications: { name: "Zapnivo Notifications",  email: "notifications@zapnivo.com", replyTo: "support@zapnivo.com" },
  security:      { name: "Zapnivo Security",       email: "security@zapnivo.com",     replyTo: "security@zapnivo.com" },
  operations:    { name: "Zapnivo Operations",     email: "operations@zapnivo.com",   replyTo: "operations@zapnivo.com" },
  legal:         { name: "Zapnivo Legal",          email: "legal@zapnivo.com",        replyTo: "legal@zapnivo.com" },
  admin:         { name: "Zapnivo Administration", email: "admin@zapnivo.com",        replyTo: "admin@zapnivo.com" },
  noreply:       { name: "Zapnivo noreply",        email: "noreply@zapnivo.com",      replyTo: "support@zapnivo.com" },
} as const;

/** Returns the sender record for a known id, or null for missing/unknown ids (caller falls back to env). */
export const resolveSender = (id?: string | null) =>
  (id && id in EMAIL_SENDERS ? EMAIL_SENDERS[id as EmailSenderId] : null);
