export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSiteEntry } from "@/lib/system/site-cms";
import { listSiteMedia, MEDIA_CATEGORIES, type SiteMediaItem } from "@/lib/system/site-media";
import { MediaLibrary } from "./MediaLibrary";

export const metadata: Metadata = { title: "Website — Media library" };

/** /system/sites/[site]/media — CMS media library for one registry site. */
export default async function SiteMediaPage({ params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  const entry = getSiteEntry(site);
  if (!entry) notFound();

  const db = serviceClient();
  const items = db ? await listSiteMedia(db, site, { includeArchived: true }) : [];

  const serializable: SiteMediaItem[] = items.map((i) => ({ ...i }));

  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-4">
        <div>
          <p className="eyebrow text-lime">
            <Link href="/system/sites" className="hover:text-white">Website</Link>
            {" / "}
            <Link href={`/system/sites/${site}`} className="hover:text-white">{entry.label}</Link>
            {" / "}media
          </p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Media library</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Images uploaded here are stored in the private <code className="font-mono text-xs">site-media</code> bucket
            and served same-origin via <code className="font-mono text-xs">/api/system/sites/media/file/…</code>.
            Bytes are validated by magic-byte sniffing (jpg/png/webp/gif/avif only — SVG rejected), capped at 5&nbsp;MB,
            and require alt text. Items referenced by content can&apos;t be deleted — archive them instead.
            {!db && " Backend not configured — uploads and the library are unavailable."}
          </p>
        </div>
        <MediaLibrary
          site={site}
          items={serializable}
          categories={[...MEDIA_CATEGORIES]}
          backendConfigured={!!db}
        />
      </div>
    </SystemGate>
  );
}
