import { describeRental, type RentalResult, type RentalRow } from "./rental-lookup";

/** Why a station can or can't be rented from. Never claims availability we can't see. */
export type StationAvailability =
  | { ok: true; venueName: string; address: string; hours: string | null }
  | { ok: false; reason: "unknown" | "offline" | "unpublished" | "unconfigured" };

export type KioskVenueRow = {
  station_id: string;
  state: string;
  installed_at: string | null;
  venues: { name: string; street: string; city: string; state: string; zip: string | null; hours: string | null; published: boolean } | null;
} | null;

export function decideAvailability(row: KioskVenueRow, configured = true): StationAvailability {
  if (!configured) return { ok: false, reason: "unconfigured" };
  if (!row) return { ok: false, reason: "unknown" };
  if (row.state !== "online" || !row.installed_at) return { ok: false, reason: "offline" };
  const v = row.venues;
  if (!v || !v.published) return { ok: false, reason: "unpublished" };
  return { ok: true, venueName: v.name, address: `${v.street}, ${v.city}, ${v.state}${v.zip ? ` ${v.zip}` : ""}`, hours: v.hours };
}

export const STATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Escape LIKE wildcards so an email can be matched case-insensitively with ilike. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

export type HistoryRentalRow = RentalRow & { id?: string; created_at?: string };
export type HistoryItem = RentalResult & { receiptHref: string; reportHref: string; sortKey: string };

/** Merge rentals found by profile id and by receipt email; dedupe by reference; newest first. */
export function shapeHistory(...groups: HistoryRentalRow[][]): HistoryItem[] {
  const seen = new Map<string, HistoryRentalRow>();
  for (const g of groups) for (const r of g) if (!seen.has(r.reference)) seen.set(r.reference, r);
  return [...seen.values()]
    .map((r) => ({
      ...describeRental(r),
      receiptHref: `/api/receipts/${encodeURIComponent(r.reference)}`,
      reportHref: `/account/incident?rental=${encodeURIComponent(r.reference)}`,
      sortKey: r.dispensed_at ?? r.started_at ?? r.created_at ?? "",
    }))
    .sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
}

export const consoleFor = (role: string): { href: string; label: string } | null =>
  role === "partner" ? { href: "/partners", label: "Partner portal" } : role === "admin" || role === "staff" ? { href: "/admin", label: "Staff console" } : null;

export const homeFor = (role: string | null | undefined) => (role === "partner" ? "/partners" : role === "customer" ? "/account" : role ? "/admin" : "/");

export const INCIDENT_KINDS = ["lost", "damaged", "stolen", "other"] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];
export const incidentCategory = (k: IncidentKind) => (k === "damaged" ? "Damaged charger" : "Other");

/** Only same-origin relative paths are honored for post-login redirects. */
export const safeNext = (n: string | null | undefined) => (n && /^\/[A-Za-z0-9/_-]*$/.test(n) && !n.startsWith("//") ? n : null);
