export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { SITE_REGISTRY, catalogPages, siteContentCounts } from "@/lib/system/site-cms";

export const metadata: Metadata = { title: "Website — Sites" };

const badge = (c: string) =>
  c === "public"
    ? "bg-lime/15 text-lime ring-lime/30"
    : "bg-white/10 text-slate-300 ring-white/15";

/**
 * /system/sites — registry of the 7 hosts with public/private classification and
 * CMS content counts. "Health" is intentionally not probed live; deployments are
 * the source of truth for host status.
 */
export default async function SitesPage() {
  const db = serviceClient();
  const counts = await siteContentCounts(db);

  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-4">
        <div>
          <p className="eyebrow text-lime">Website</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Website management</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            CMS for the public web properties. Only fields the live render path actually consumes are
            editable (whitelist in <code className="font-mono text-xs">src/lib/system/site-cms.ts</code>).
            Drafts never affect the live site until published; publishes and schedules require step-up
            verification. Host health is not probed here — see deployments for release status.
          </p>
        </div>

        {!db ? (
          <p className="rounded-2xl border border-white/[0.08] bg-white/[0.05] px-6 py-10 text-sm text-slate-400">
            Backend not configured — site registry unavailable.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {SITE_REGISTRY.map((s) => {
              const pages = catalogPages(s.key);
              return (
                <Link
                  key={s.key}
                  href={`/system/sites/${s.key}`}
                  className="group rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5 shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)] transition-colors hover:border-lime/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="font-display text-lg font-bold text-white group-hover:text-lime">{s.label}</h2>
                      <p className="mt-0.5 font-mono text-[11px] text-slate-500">{s.host}</p>
                    </div>
                    <span className={`rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider ring-1 ${badge(s.classification)}`}>
                      {s.classification}
                    </span>
                  </div>
                  <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
                    <span>{pages.length > 0 ? `${pages.length} editable page${pages.length === 1 ? "" : "s"}` : "No editable fields yet"}</span>
                    <span className="font-mono text-[10px] text-slate-500">{counts[s.key] ?? 0} content rows</span>
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
