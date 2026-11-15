import type { Metadata } from "next";
import Link from "next/link";
import VendingLanding from "@/components/VendingLanding";
import { Button } from "@/components/ui";
import { KioskScenePhoto } from "@/components/Photo";
import { VENDING_PAGE_CONTENT } from "@/lib/vending-content";
import { resolveVendingCategory, vendingCms, vendingCta, vendingIntro, vendingMetadata } from "@/lib/vending-seo";
import { getStations } from "@/lib/stations";

const SLUG = "locations";
const base = VENDING_PAGE_CONTENT[SLUG];

export async function generateMetadata(): Promise<Metadata> {
  return vendingMetadata(base.pageKey, base.metaTitle, base.metaDescription);
}

export default async function VendingLocationsPage() {
  const [cms, stations] = await Promise.all([vendingCms(base.pageKey), getStations()]);
  const cta = vendingCta(cms, SLUG);
  return (
    <VendingLanding
      category={resolveVendingCategory(SLUG, cms)}
      ctaHref={cta.href}
      ctaLabel={cta.label}
      introBody={vendingIntro(cms)}
      visual={<KioskScenePhoto scene="shopping" />}
    >
      <div className="space-y-4">
        <div>
          <h3 className="font-display text-lg font-bold">Phone charger stations</h3>
          <p className="mt-1 text-sm leading-6 text-graphite">
            Verified live charger rental stations are listed on the station map — we only publish locations that are installed, verified, and online.
          </p>
        </div>
        {stations.length > 0 ? (
          <ul className="space-y-2">
            {stations.map((s) => (
              <li key={s.id}>
                <Link href={`/r/${s.id}`} className="flex items-center justify-between gap-3 rounded-lg border border-mist px-4 py-3 text-sm font-bold hover:border-forest">
                  <span>{s.name} — {s.city}, {s.state}</span>
                  <span className="text-forest">View →</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg bg-mist/60 p-4 text-sm leading-6 text-graphite">
            No verified charger stations are published yet. As installations go live they appear on the <Link href="/locations" className="font-bold underline underline-offset-4">station map</Link> — we never list locations that aren't real.
          </p>
        )}
        <Button href="/locations" variant="ghost">Open the station map</Button>
      </div>
    </VendingLanding>
  );
}
