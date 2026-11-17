export type SupportTitle = "manager" | "support_agent";

/** Customer-facing identity. Never derive a name from an email local part. */
export function supportIdentity(profile: { full_name?: string | null; role?: string | null; support_title?: string | null } | null): string {
  const name = profile?.full_name?.trim().replace(/\s+/g, " ");
  const completeName = name && name.split(" ").length >= 2 ? name : "Zapnivo Support";
  const title: SupportTitle = profile?.support_title === "manager" || (profile?.support_title == null && profile?.role === "admin")
    ? "manager" : "support_agent";
  return `${completeName} · ${title === "manager" ? "Manager" : "Support agent"}`;
}
