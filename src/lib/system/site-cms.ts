import type { SupabaseClient } from "@supabase/supabase-js";
import { systemAudit, type SystemActor } from "./audit";

/**
 * Website Management Center — site CMS (migration 0058).
 *
 * Scope honesty: FIELD_CATALOG below is a WHITELIST of fields the live render
 * path actually consumes today (apex homepage hero/meta, the announcement bar,
 * and the footer contact email). Pages/sites with no rendered fields have an
 * empty catalog — the UI shows an honest "nothing editable yet" state rather
 * than fake controls.
 *
 * Values are plain scalars (string / boolean). "richtext" fields are markdown-
 * lite plain text: `<` and `>` are stripped on save, so no HTML/JS can ever be
 * stored, and the renderer only ever emits React text nodes.
 *
 * Lifecycle: draft_value is edited freely; publish copies draft → published;
 * schedule snapshots draft → published_value but gates serving on scheduled_at
 * (see src/lib/site-content.ts). Revisions are append-only.
 */

/* ── Site registry (the 7 hosts from src/lib/subdomains.ts) ────────────────── */

export type SiteClassification = "public" | "private";

export type SiteRegistryEntry = {
  key: string;
  label: string;
  host: string;
  classification: SiteClassification;
};

export const SITE_REGISTRY: readonly SiteRegistryEntry[] = [
  { key: "apex", label: "Marketing site", host: "zapnivo.com / www.zapnivo.com", classification: "public" },
  { key: "support", label: "Help center", host: "support.zapnivo.com", classification: "public" },
  { key: "internal", label: "Staff admin", host: "internal.zapnivo.com", classification: "private" },
  { key: "partners", label: "Partner portal", host: "partners.zapnivo.com", classification: "private" },
  { key: "customer", label: "Customer accounts", host: "customer.zapnivo.com", classification: "private" },
  { key: "system", label: "System console", host: "system.zapnivo.com", classification: "private" },
  { key: "api", label: "API host", host: "api.zapnivo.com", classification: "private" },
] as const;

export const SITE_KEYS = SITE_REGISTRY.map((s) => s.key);
export const isSiteKey = (v: unknown): v is string => typeof v === "string" && SITE_KEYS.includes(v);
export const getSiteEntry = (key: string): SiteRegistryEntry | undefined =>
  SITE_REGISTRY.find((s) => s.key === key);

/* ── Field catalog (whitelist — only fields the live site renders) ─────────── */

export type FieldType = "string" | "richtext" | "url" | "image" | "boolean";

export type FieldDef = {
  key: string;
  label: string;
  type: FieldType;
  /** Hard cap enforced on save (characters for text, ignored otherwise). */
  maxLength?: number;
  /** Extra format constraint for string fields. */
  format?: "email";
  help?: string;
};

const f = (key: string, label: string, type: FieldType, extra: Partial<FieldDef> = {}): FieldDef =>
  ({ key, label, type, ...extra });

/**
 * page_key "home"    → apex homepage hero + metadata (src/app/(site)/page.tsx)
 * page_key "global"  → announcement bar (src/components/Header.tsx via (site)/layout)
 * page_key "footer"  → footer contact email (src/components/Footer.tsx)
 * page_key "contact" → apex /contact hero + metadata ((site)/contact/page.tsx)
 * page_key "home" (support)   → help-center hero + metadata ((site)/support/page.tsx → HelpCenter)
 * page_key "global" (partners)→ portal announcement banner (components/PartnerShell.tsx)
 * page_key "global" (internal)→ portal announcement banner (components/AdminShell.tsx)
 * page_key "home" (customer)  → account portal hero + intro ((site)/account/page.tsx)
 *
 * Cataloged per site (multi-site phase):
 *  - support:  help-center hero eyebrow/headline + page meta — wired via HelpCenter props.
 *  - partners: announcement banner inside PartnerGate — no public render surface exists
 *              (partners.zapnivo.com rewrites / → gated /partners), so ONLY the portal
 *              banner fields are cataloged.
 *  - internal: announcement banner inside AdminGate — same reasoning (→ /admin).
 *  - customer: account portal hero eyebrow/title + intro line on /account.
 *  - system / api: NO catalog — the system console chrome (SystemShell) and the API
 *    host have no CMS-consumed render surface; nothing is cataloged speculatively.
 *
 * Image-type fields: the "image" FieldType accepts /images/ paths or registered
 * site_media refs (see src/lib/system/site-media.ts). The media library
 * (migration 0061, /system/sites/[site]/media) supplies those refs; image fields
 * are only cataloged where a render surface consumes them (e.g. apex/newsletter).
 */
export const FIELD_CATALOG: Record<string, Record<string, FieldDef[]>> = {
  apex: {
    home: [
      f("hero_eyebrow", "Hero eyebrow", "string", { maxLength: 120, help: "Small caps line above the headline." }),
      f("hero_headline_a", "Hero headline — line 1", "string", { maxLength: 80, help: "First line of the H1." }),
      f("hero_headline_b", "Hero headline — line 2 (accent)", "string", { maxLength: 80, help: "Second line, rendered in the accent color." }),
      f("hero_subhead", "Hero subhead", "richtext", { maxLength: 600, help: "Plain text; **bold** is the only markup rendered." }),
      f("meta_title", "Meta title", "string", { maxLength: 70, help: "<title> / social title for the homepage." }),
      f("meta_description", "Meta description", "string", { maxLength: 170, help: "Search + share description for the homepage." }),
    ],
    global: [
      f("announcement_enabled", "Show announcement bar", "boolean"),
      f("announcement_text", "Announcement text", "string", { maxLength: 160, help: "Replaces the default top strip when enabled." }),
      f("announcement_href", "Announcement link", "url", { help: "Optional https:// or site-relative path." }),
    ],
    footer: [
      f("contact_email", "Footer contact email", "string", { format: "email", maxLength: 120, help: "Replaces the first footer contact address." }),
    ],
    // Newsletter popup — consumed by src/components/NewsletterPopup.tsx via
    // (site)/layout.tsx → getPublishedContent("apex", "newsletter").
    newsletter: [
      f("enabled", "Show newsletter popup", "boolean", { help: "Master switch. Default on; disable to hide everywhere." }),
      f("headline", "Headline", "string", { maxLength: 90, help: "Default: Never Run Out of Power." }),
      f("description", "Description", "richtext", { maxLength: 400, help: "Plain text shown under the headline." }),
      f("cta_customer", "Customer button label", "string", { maxLength: 60, help: "Submit label on the customer tab." }),
      f("cta_business", "Business button label", "string", { maxLength: 60, help: "Submit label on the business tab." }),
      f("image", "Popup image", "image", { help: "Optional real photo; empty = typographic design (no placeholder art)." }),
      f("delay_seconds", "Show delay (seconds)", "string", { maxLength: 3, help: "Seconds after page load before the popup appears (0–120)." }),
      f("frequency_cap_days", "Frequency cap (days)", "string", { maxLength: 3, help: "Minimum days between popup shows per visitor (1–365)." }),
      f("excluded_routes", "Excluded routes", "string", { maxLength: 500, help: "Comma-separated paths where the popup never appears." }),
      f("success_message", "Success message", "string", { maxLength: 200, help: "Shown after a subscription is captured (pre-confirmation)." }),
      f("business_cta_href", "Business CTA link", "url", { help: "Where the 'full application' link on the business tab points." }),
    ],
    contact: [
      f("hero_eyebrow", "Hero eyebrow", "string", { maxLength: 120 }),
      f("hero_title", "Hero title", "string", { maxLength: 120, help: "Main heading on /contact." }),
      f("hero_description", "Hero description", "string", { maxLength: 400, help: "Plain text intro under the heading." }),
      f("meta_title", "Meta title", "string", { maxLength: 70 }),
      f("meta_description", "Meta description", "string", { maxLength: 170 }),
    ],
  },
  support: {
    home: [
      f("hero_eyebrow", "Hero eyebrow", "string", { maxLength: 120, help: "Small caps line above the headline on the help center." }),
      f("hero_headline", "Hero headline", "string", { maxLength: 120, help: "Main heading (H1) on the help center." }),
      f("meta_title", "Meta title", "string", { maxLength: 70 }),
      f("meta_description", "Meta description", "string", { maxLength: 170 }),
    ],
  },
  internal: {
    global: [
      f("announcement_enabled", "Show announcement banner", "boolean", { help: "Renders a notice bar at the top of every staff console page." }),
      f("announcement_text", "Announcement text", "string", { maxLength: 200 }),
      f("announcement_href", "Announcement link", "url", { help: "Optional https:// or site-relative path." }),
    ],
  },
  partners: {
    global: [
      f("announcement_enabled", "Show announcement banner", "boolean", { help: "Renders a notice bar at the top of every partner portal page." }),
      f("announcement_text", "Announcement text", "string", { maxLength: 200 }),
      f("announcement_href", "Announcement link", "url", { help: "Optional https:// or site-relative path." }),
    ],
  },
  customer: {
    home: [
      f("hero_eyebrow", "Hero eyebrow", "string", { maxLength: 120 }),
      f("hero_title", "Hero title", "string", { maxLength: 120, help: "Main heading on the customer account overview." }),
      f("intro_text", "Intro text", "richtext", { maxLength: 400, help: "Shown under the heading, above the signed-in line. **bold** is the only markup." }),
    ],
  },
  system: {},
  api: {},
};

export const catalogPages = (siteKey: string): string[] => Object.keys(FIELD_CATALOG[siteKey] ?? {});
export const catalogPageExists = (siteKey: string, pageKey: string): boolean =>
  Object.prototype.hasOwnProperty.call(FIELD_CATALOG[siteKey] ?? {}, pageKey);
export const catalogFields = (siteKey: string, pageKey: string): FieldDef[] =>
  FIELD_CATALOG[siteKey]?.[pageKey] ?? [];
/** Whitelist lookup — unknown site/page/field returns null (routes 404/422 on it). */
export const catalogField = (siteKey: string, pageKey: string, fieldKey: string): FieldDef | null =>
  catalogFields(siteKey, pageKey).find((d) => d.key === fieldKey) ?? null;

/* ── Validation / sanitization (pure — unit tested) ────────────────────────── */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const EMAIL_RE = /^[^\s@<>"'`]+@[^\s@<>"'`]+\.[^\s@<>"'`]+$/;

export type ValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

const cleanText = (raw: unknown, maxLength: number): string | null => {
  if (typeof raw !== "string") return null;
  // Strip angle brackets entirely — no HTML can survive; React would escape
  // anyway, this is defense in depth plus an honest "no markup" guarantee.
  const cleaned = raw.replace(/[<>]/g, "").replace(CONTROL_CHARS, "").trim();
  if (cleaned.length > maxLength) return null;
  return cleaned;
};

const isSafeUrl = (v: string): boolean => {
  if (v === "") return true; // empty = unset, allowed for optional url fields
  if (v.length > 500 || /\s/.test(v)) return false;
  if (v.startsWith("/")) return !v.startsWith("//"); // relative path only, no protocol-relative
  return /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:[/?#][^\s<>"'`]*)?$/.test(v);
};

const isSafeImageRef = (v: string, registered?: ReadonlySet<string>): boolean => {
  if (v === "") return true;
  if (v.length > 500 || /[<>"'`\s]/.test(v)) return false;
  if (v.startsWith("/images/")) return true;
  // Registered CMS media: either the stored path or its public URL form.
  if (registered?.has(v)) return true;
  return false;
};

/**
 * Validates + sanitizes a raw input value against a catalog field definition.
 * `registeredMedia` (optional) is the set of site_media paths/urls allowed for
 * image fields. Returns the sanitized value to store, or an error.
 */
export function validateFieldValue(
  def: FieldDef,
  raw: unknown,
  registeredMedia?: ReadonlySet<string>,
): ValidationResult {
  switch (def.type) {
    case "boolean":
      return typeof raw === "boolean"
        ? { ok: true, value: raw }
        : { ok: false, error: "Expected a boolean" };
    case "url": {
      const v = cleanText(raw, 500);
      if (v === null) return { ok: false, error: `Invalid URL (max ${def.maxLength ?? 500} chars)` };
      if (!isSafeUrl(v)) return { ok: false, error: "URL must be https:// or a site-relative path" };
      return { ok: true, value: v };
    }
    case "image": {
      if (typeof raw !== "string") return { ok: false, error: "Expected a string" };
      const v = raw.trim();
      if (!isSafeImageRef(v, registeredMedia)) {
        return { ok: false, error: "Image must be an /images/ path or registered CMS media" };
      }
      return { ok: true, value: v };
    }
    case "string":
    case "richtext": {
      const max = def.maxLength ?? 500;
      const v = cleanText(raw, max);
      if (v === null) return { ok: false, error: `Invalid text (must be a string, max ${max} chars, no < or >)` };
      if (def.format === "email" && v !== "" && !EMAIL_RE.test(v)) {
        return { ok: false, error: "Invalid email address" };
      }
      return { ok: true, value: v };
    }
  }
}

/* ── Row types ─────────────────────────────────────────────────────────────── */

export type SiteContentRow = {
  id: string;
  site_key: string;
  page_key: string;
  field_key: string;
  locale: string;
  draft_value: unknown;
  published_value: unknown;
  status: "draft" | "published" | "scheduled";
  scheduled_at: string | null;
  version: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ContentRevision = {
  id: string;
  content_id: string;
  version: number;
  value: unknown;
  action: "save_draft" | "publish" | "schedule" | "revert";
  actor: string | null;
  created_at: string;
};

const CONTENT_COLS =
  "id,site_key,page_key,field_key,locale,draft_value,published_value,status,scheduled_at,version,updated_by,created_at,updated_at";
const REV_COLS = "id,content_id,version,value,action,actor,created_at";

const asRow = (v: unknown): SiteContentRow | null => {
  const r = v as Partial<SiteContentRow> | null;
  if (!r || typeof r.id !== "string") return null;
  return r as SiteContentRow;
};

/* ── Reads (system console) ────────────────────────────────────────────────── */

export async function listSiteContent(db: SupabaseClient | null, siteKey: string): Promise<SiteContentRow[]> {
  if (!db || !isSiteKey(siteKey)) return [];
  const { data, error } = await db
    .from("site_content")
    .select(CONTENT_COLS)
    .eq("site_key", siteKey)
    .order("page_key")
    .order("field_key")
    .limit(1000);
  if (error || !Array.isArray(data)) return [];
  return data.map(asRow).filter((r): r is SiteContentRow => r !== null);
}

/** Per-site content counts for the registry cards. */
export async function siteContentCounts(db: SupabaseClient | null): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  if (!db) return counts;
  const { data, error } = await db.from("site_content").select("site_key").limit(5000);
  if (error || !Array.isArray(data)) return counts;
  for (const r of data as { site_key?: unknown }[]) {
    if (typeof r.site_key === "string") counts[r.site_key] = (counts[r.site_key] ?? 0) + 1;
  }
  return counts;
}

export async function getContentRow(
  db: SupabaseClient | null,
  siteKey: string,
  pageKey: string,
  fieldKey: string,
  locale = "en",
): Promise<SiteContentRow | null> {
  if (!db) return null;
  const { data, error } = await db
    .from("site_content")
    .select(CONTENT_COLS)
    .eq("site_key", siteKey)
    .eq("page_key", pageKey)
    .eq("field_key", fieldKey)
    .eq("locale", locale)
    .maybeSingle();
  if (error) return null;
  return asRow(data);
}

export async function listPageRevisions(
  db: SupabaseClient | null,
  siteKey: string,
  pageKey: string,
  locale = "en",
  limit = 50,
): Promise<(ContentRevision & { field_key: string; page_key: string })[]> {
  if (!db) return [];
  const { data: rows, error } = await db
    .from("site_content")
    .select("id,field_key")
    .eq("site_key", siteKey)
    .eq("page_key", pageKey)
    .eq("locale", locale)
    .limit(200);
  if (error || !Array.isArray(rows) || rows.length === 0) return [];
  const ids = (rows as { id: string; field_key: string }[]).map((r) => r.id);
  const fieldById = new Map((rows as { id: string; field_key: string }[]).map((r) => [r.id, r.field_key]));
  const { data: revs, error: revErr } = await db
    .from("site_content_revisions")
    .select(REV_COLS)
    .in("content_id", ids)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (revErr || !Array.isArray(revs)) return [];
  return (revs as ContentRevision[]).map((r) => ({
    ...r,
    field_key: fieldById.get(r.content_id) ?? "",
    page_key: pageKey,
  }));
}

/** Registered media refs (paths + urls) for image-field validation. */
export async function registeredMediaRefs(db: SupabaseClient | null, siteKey: string): Promise<Set<string>> {
  const refs = new Set<string>();
  if (!db) return refs;
  const { data } = await db
    .from("site_media")
    .select("path,url")
    .eq("site_key", siteKey)
    .limit(1000);
  for (const r of (data ?? []) as { path?: unknown; url?: unknown }[]) {
    if (typeof r.path === "string") refs.add(r.path);
    if (typeof r.url === "string") refs.add(r.url);
  }
  return refs;
}

/* ── Mutations ─────────────────────────────────────────────────────────────── */

export type CmsResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { data: T }))
  | { ok: false; status: number; error: string };

const fail = (status: number, error: string) => ({ ok: false as const, status, error });

async function insertRevision(
  db: SupabaseClient,
  contentId: string,
  version: number,
  value: unknown,
  action: ContentRevision["action"],
  actor: SystemActor,
): Promise<void> {
  await db.from("site_content_revisions").insert({
    content_id: contentId,
    version,
    value: value ?? null,
    action,
    actor: actor.id,
  });
}

/**
 * Saves a draft value for a catalog field. Whitelist + validation enforced here;
 * callers must already have checked permissions. Keeps a pending 'scheduled'
 * status untouched so a draft edit never accidentally publishes a snapshot.
 */
export async function saveDraft(
  db: SupabaseClient,
  actor: SystemActor,
  input: { siteKey: string; pageKey: string; fieldKey: string; value: unknown; locale?: string },
): Promise<CmsResult<SiteContentRow>> {
  const def = catalogField(input.siteKey, input.pageKey, input.fieldKey);
  if (!def) return fail(404, "Unknown content field");
  const locale = input.locale ?? "en";
  const registered = def.type === "image" ? await registeredMediaRefs(db, input.siteKey) : undefined;
  const check = validateFieldValue(def, input.value, registered);
  if (!check.ok) return fail(422, check.error);

  const existing = await getContentRow(db, input.siteKey, input.pageKey, input.fieldKey, locale);
  const now = new Date().toISOString();
  const nextVersion = (existing?.version ?? 0) + 1;
  const keepScheduled = existing?.status === "scheduled";
  const payload = {
    site_key: input.siteKey,
    page_key: input.pageKey,
    field_key: input.fieldKey,
    locale,
    draft_value: check.value ?? null,
    status: keepScheduled ? "scheduled" : "draft",
    scheduled_at: keepScheduled ? existing!.scheduled_at : existing?.scheduled_at ?? null,
    version: nextVersion,
    updated_by: actor.id,
    updated_at: now,
  };
  const { data, error } = await db
    .from("site_content")
    .upsert(payload, { onConflict: "site_key,page_key,field_key,locale" })
    .select(CONTENT_COLS)
    .single();
  if (error || !data) return fail(500, error?.message ?? "draft save failed");
  const row = asRow(data);
  if (!row) return fail(500, "draft save failed");
  await insertRevision(db, row.id, nextVersion, check.value, "save_draft", actor);
  await systemAudit(db, {
    actor,
    action: "sitecms.draft_saved",
    resource: `site_content:${input.siteKey}/${input.pageKey}/${input.fieldKey}`,
    detail: { site: input.siteKey, page: input.pageKey, field: input.fieldKey, version: nextVersion },
  });
  return { ok: true, data: row };
}

/** Loads the content row for a catalog field or fails with an honest error. */
async function requireDraftable(
  db: SupabaseClient,
  siteKey: string,
  pageKey: string,
  fieldKey: string,
): Promise<{ ok: true; row: SiteContentRow } | { ok: false; status: number; error: string }> {
  const def = catalogField(siteKey, pageKey, fieldKey);
  if (!def) return { ok: false, status: 404, error: "Unknown content field" };
  const row = await getContentRow(db, siteKey, pageKey, fieldKey);
  if (!row || row.draft_value === null || row.draft_value === undefined) {
    return { ok: false, status: 409, error: "No draft to publish — save a draft first" };
  }
  return { ok: true, row };
}

async function bumpRow(
  db: SupabaseClient,
  row: SiteContentRow,
  fields: Record<string, unknown>,
): Promise<SiteContentRow | null> {
  const version = row.version + 1;
  const { data, error } = await db
    .from("site_content")
    .update({ ...fields, version, updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .select(CONTENT_COLS)
    .single();
  if (error || !data) return null;
  return asRow(data);
}

/** publish: draft_value → published_value, status 'published', schedule cleared. */
export async function publishDraft(
  db: SupabaseClient,
  actor: SystemActor,
  input: { siteKey: string; pageKey: string; fieldKey: string },
): Promise<CmsResult<SiteContentRow>> {
  const found = await requireDraftable(db, input.siteKey, input.pageKey, input.fieldKey);
  if (!found.ok) return fail(found.status, found.error);
  const row = found.row;
  const updated = await bumpRow(db, row, {
    published_value: row.draft_value,
    status: "published",
    scheduled_at: null,
    updated_by: actor.id,
  });
  if (!updated) return fail(500, "publish failed");
  await insertRevision(db, updated.id, updated.version, row.draft_value, "publish", actor);
  await systemAudit(db, {
    actor,
    action: "sitecms.published",
    resource: `site_content:${input.siteKey}/${input.pageKey}/${input.fieldKey}`,
    detail: { site: input.siteKey, page: input.pageKey, field: input.fieldKey, version: updated.version },
  });
  return { ok: true, data: updated };
}

/** schedule: snapshot draft → published_value, gate live-serving on scheduled_at. */
export async function schedulePublish(
  db: SupabaseClient,
  actor: SystemActor,
  input: { siteKey: string; pageKey: string; fieldKey: string; scheduledAt: string },
): Promise<CmsResult<SiteContentRow>> {
  const found = await requireDraftable(db, input.siteKey, input.pageKey, input.fieldKey);
  if (!found.ok) return fail(found.status, found.error);
  const at = Date.parse(input.scheduledAt);
  if (!Number.isFinite(at) || at <= Date.now()) {
    return fail(422, "scheduled_at must be a future ISO timestamp");
  }
  const row = found.row;
  const updated = await bumpRow(db, row, {
    published_value: row.draft_value, // snapshot — live only once scheduled_at passes
    status: "scheduled",
    scheduled_at: new Date(at).toISOString(),
    updated_by: actor.id,
  });
  if (!updated) return fail(500, "schedule failed");
  await insertRevision(db, updated.id, updated.version, row.draft_value, "schedule", actor);
  await systemAudit(db, {
    actor,
    action: "sitecms.scheduled",
    resource: `site_content:${input.siteKey}/${input.pageKey}/${input.fieldKey}`,
    detail: { site: input.siteKey, page: input.pageKey, field: input.fieldKey, scheduled_at: updated.scheduled_at },
  });
  return { ok: true, data: updated };
}

/** revert: restore published_value from a prior revision (already-sanitized value). */
export async function revertToRevision(
  db: SupabaseClient,
  actor: SystemActor,
  input: { siteKey: string; revisionId: string },
): Promise<CmsResult<SiteContentRow>> {
  const { data: revRaw, error: revErr } = await db
    .from("site_content_revisions")
    .select(REV_COLS)
    .eq("id", input.revisionId)
    .maybeSingle();
  if (revErr) return fail(500, revErr.message);
  const rev = revRaw as ContentRevision | null;
  if (!rev) return fail(404, "Revision not found");
  const { data: rowRaw, error: rowErr } = await db
    .from("site_content")
    .select(CONTENT_COLS)
    .eq("id", rev.content_id)
    .maybeSingle();
  if (rowErr) return fail(500, rowErr.message);
  const row = asRow(rowRaw);
  if (!row) return fail(404, "Content row not found");
  if (row.site_key !== input.siteKey) return fail(404, "Revision not found for this site");

  const updated = await bumpRow(db, row, {
    published_value: rev.value ?? null,
    status: "published",
    scheduled_at: null,
    updated_by: actor.id,
  });
  if (!updated) return fail(500, "revert failed");
  await insertRevision(db, updated.id, updated.version, rev.value, "revert", actor);
  await systemAudit(db, {
    actor,
    action: "sitecms.reverted",
    resource: `site_content:${row.site_key}/${row.page_key}/${row.field_key}`,
    detail: { site: row.site_key, page: row.page_key, field: row.field_key, from_revision: rev.id, version: updated.version },
  });
  return { ok: true, data: updated };
}

/* ── Media registry (metadata only — see migration 0058 notes) ─────────────── */

export type SiteMediaRow = {
  id: string;
  site_key: string;
  path: string;
  url: string | null;
  alt_text: string;
  mime: string | null;
  bytes: number | null;
  storage_bucket: string | null;
  uploaded_by: string | null;
  created_at: string;
};

export async function listMedia(db: SupabaseClient | null, siteKey: string): Promise<SiteMediaRow[]> {
  if (!db || !isSiteKey(siteKey)) return [];
  const { data, error } = await db
    .from("site_media")
    .select("id,site_key,path,url,alt_text,mime,bytes,storage_bucket,uploaded_by,created_at")
    .eq("site_key", siteKey)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error || !Array.isArray(data)) return [];
  return data as SiteMediaRow[];
}
