export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { catalogFields, catalogPages, getSiteEntry, listSiteContent } from "@/lib/system/site-cms";

export const metadata: Metadata = { title: "Website — Site" };

/** /system/sites/[site] — editable pages for one registry site. */
export default async function SiteDetailPage({ params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  const entry = getSiteEntry(site);
  if (!entry) notFound();

  const db = serviceClient();
  const rows = db ? await listSiteContent(db, site) : [];
  const pages = catalogPages(site);

  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-4">
        <div>
          <p className="eyebrow text-lime">Website / {entry.label}</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">{entry.label}</h1>
          <p className="mt-1 font-mono text-xs text-slate-500">
            {entry.host} · {entry.classification}
          </p>
        </div>

        {pages.length === 0 ? (
          <p className="rounded-2xl border border-white/[0.08] bg-white/[0.05] px-6 py-10 text-sm text-slate-400">
            No editable content fields are wired to this site&apos;s render path yet. Fields appear here
            only when the live site actually consumes them — nothing is cataloged speculatively.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {pages.map((pageKey) => {
              const defs = catalogFields(site, pageKey);
              const pageRows = rows.filter((r) => r.page_key === pageKey);
              const published = pageRows.filter((r) => r.status === "published" || (r.status === "draft" && r.published_value !== null)).length;
              const scheduled = pageRows.filter((r) => r.status === "scheduled" && r.scheduled_at && Date.parse(r.scheduled_at) > Date.now()).length;
              return (
                <Link
                  key={pageKey}
                  href={`/system/sites/${site}/${pageKey}`}
                  className="group rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5 transition-colors hover:border-lime/40"
                >
                  <div className="flex items-center justify-between">
                    <h2 className="font-display text-lg font-bold text-white group-hover:text-lime">/{pageKey}</h2>
                    <span className="font-mono text-[10px] text-slate-500">{defs.length} fields</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-[10px] font-bold uppercase tracking-wider">
                    <span className="rounded-full bg-lime/15 px-2 py-0.5 text-lime ring-1 ring-lime/30">{published} live</span>
                    {scheduled > 0 && <span className="rounded-full bg-cyan/15 px-2 py-0.5 text-cyan ring-1 ring-cyan/30">{scheduled} scheduled</span>}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </SystemGate>
  );
}
