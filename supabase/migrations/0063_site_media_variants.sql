-- Migration 0063 — Website Management Center media variants + processing meta.
--
-- Phase 3.2 adds real image processing to the site_media pipeline
-- (src/lib/system/site-media-process.ts). On upload the original bytes are
-- retained unchanged (revisions/rollback need them) and two webp derivatives
-- are generated: thumb (400px) and card (1200px). Variant storage paths and
-- intrinsic sizes live in the new jsonb column:
--
--   variants = {
--     "thumb": { "path": "site/<uuid>.thumb.webp", "mime": "image/webp",
--                "bytes": 12345, "width": 400, "height": 267 },
--     "card":  { ... }
--   }
--
-- variant_error records the LAST processing failure honestly (NULL = clean).
-- When set, variants is empty/partial and the serve route falls back to the
-- original — the UI shows "original only" rather than pretending variants
-- exist. Variants are regenerable, so a NULL variant_error with missing keys
-- also means "not generated".
--
-- No new tables, no RLS changes: variants ride the existing site_media row
-- (staff SELECT via has_system_access() from 0058/0061 still applies; writes
-- remain service-role only).

alter table site_media
  add column if not exists variants jsonb not null default '{}'::jsonb,
  add column if not exists variant_error text;

-- Sanity: variants must be a jsonb object (not array/scalar).
alter table site_media drop constraint if exists site_media_variants_is_object;
alter table site_media add constraint site_media_variants_is_object
  check (jsonb_typeof(variants) = 'object');
