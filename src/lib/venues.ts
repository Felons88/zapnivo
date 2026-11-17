/** Shared venue rules — publish gating lives here so routes and tests agree. */

export type VenuePublishFields = {
  name?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  lat?: number | null;
  lng?: number | null;
};

/**
 * A venue may be published only when its public listing is complete:
 * name, a real address, and coordinates for the map. Returns the missing
 * field labels (empty = publishable). Internal-only fields never gate.
 */
export function missingPublishFields(v: VenuePublishFields): string[] {
  const missing: string[] = [];
  if (!v.name?.trim()) missing.push("name");
  if (!v.street?.trim()) missing.push("street");
  if (!v.city?.trim()) missing.push("city");
  if (!v.state?.trim() || v.state.trim().length !== 2) missing.push("state");
  if (v.lat == null || v.lng == null) missing.push("coordinates");
  return missing;
}

/** Columns the public surfaces (website locator, mobile app) may ever see. */
export const VENUE_PUBLIC_SELECT =
  "name,venue_type,street,city,state,zip,hours,lat,lng,phone,website,description,cover_image_url,accessibility,published,active";

/**
 * Everything the admin form can write. Internal-only fields are included —
 * they just never leave the system API.
 */
export const VENUE_ADMIN_SELECT =
  "id,name,venue_type,street,city,state,zip,hours,lat,lng,published,active,organization_id,equipment_category,mapbox_id,phone,website,description,cover_image_url,timezone,accessibility,internal_notes,contact_name,contact_email,contact_phone,created_at";
