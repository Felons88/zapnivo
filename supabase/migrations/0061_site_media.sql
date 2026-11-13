-- Migration 0061 — Website Management Center media library (Phase B).
--
-- Extends site_media (0058) with the fields the media library UI needs:
--   category  — enum-ish text tag for filtering (brand/kiosk/powerbank/…)
--   archived  — soft-delete flag; archived media stays resolvable (published
--               content may still reference it) but is hidden from pickers
--   width/height — optional intrinsic dimensions when known at upload time
--
-- Also creates the PRIVATE storage bucket 'site-media'. Bytes are only ever
-- read/written through the service role (src/lib/system/site-media.ts +
-- /api/system/sites routes); the public never touches the bucket directly —
-- images are served through the same-origin proxy route
-- /api/system/sites/media/file/[id] so the site CSP (img-src 'self') holds and
-- bucket paths stay unguessable.
--
-- RLS: staff SELECT via has_system_access() (0058 policy still applies);
-- writes remain service-role only. storage.objects gets NO policies — the
-- bucket is private and only the service role accesses it.

alter table site_media
  add column if not exists category text not null default 'general',
  add column if not exists archived boolean not null default false,
  add column if not exists width int,
  add column if not exists height int;

alter table site_media drop constraint if exists site_media_category_check;
alter table site_media add constraint site_media_category_check
  check (category in ('general','brand','kiosk','powerbank','homepage','partner','ads','help','newsletter'));

create index if not exists site_media_category_idx on site_media (site_key, category) where archived = false;

-- Private bucket for CMS-managed site media. Service-role only; no public URL.
insert into storage.buckets (id, name, public)
values ('site-media', 'site-media', false)
on conflict (id) do nothing;
