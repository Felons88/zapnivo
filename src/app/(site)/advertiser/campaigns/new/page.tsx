import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Notice, PageHero, Section } from "@/components/ui";
import { eligibleStations, getAdvertiserPageContext, listRateCards } from "@/lib/ads/service";
import { CampaignForm } from "./CampaignForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "New campaign", robots: { index: false, follow: false } };

const OBJECTIVES = [
  ["brand_awareness", "Brand awareness"],
  ["venue_promotion", "Venue promotion"],
  ["local_business", "Local business"],
  ["event_promotion", "Event promotion"],
  ["website_traffic", "Website traffic"],
  ["qr_engagement", "QR engagement"],
  ["product_promotion", "Product promotion"],
] as const;

export default async function NewCampaign({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: orgParam } = await searchParams;
  const pc = await getAdvertiserPageContext(orgParam ?? null);
  if (pc.kind === "no_user") redirect("/login");
  if (pc.kind !== "ok") {
    return (
      <>
        <PageHero eyebrow="Advertisers" title={<>New campaign.</>} />
        <Section className="pt-14"><div className="mx-auto max-w-2xl">
          {pc.kind === "no_org"
            ? <Notice title="No organization yet."><Link className="font-bold underline" href="/advertiser">Create your organization</Link> first.</Notice>
            : <Notice title="Not configured yet.">The advertising backend isn't connected in this environment.</Notice>}
        </div></Section>
      </>
    );
  }

  const [rateCards, stations] = await Promise.all([
    listRateCards(pc.db),
    eligibleStations(pc.db, {}),
  ]);

  return (
    <>
      <PageHero eyebrow="Advertisers" title={<>Build a campaign.</>}>
        <p>For {pc.org.name}. Pick a placement, markets and a schedule — pricing comes from our current rate card, and every campaign is reviewed before it runs.</p>
      </PageHero>
      <Section className="pt-14">
        <div className="mx-auto max-w-3xl rounded-xl bg-white p-6 md:p-10">
          {rateCards.length === 0 ? (
            <Notice title="Self-serve pricing isn't live yet.">
              Rate cards haven't been published, so online checkout isn't available. <Link className="font-bold underline" href="/advertise">Contact us</Link> and we'll set up your campaign directly.
            </Notice>
          ) : stations.length === 0 ? (
            <Notice title="No stations online yet.">Eligible kiosk locations appear here once stations are live and their venues are published.</Notice>
          ) : (
            <CampaignForm
              orgId={pc.org.id}
              rateCards={rateCards.map((r) => ({ id: r.id, placement: r.placement, pricing_model: r.pricing_model, unit_price_cents: r.unit_price_cents, min_spend_cents: r.min_spend_cents, duration_days: r.duration_days, note: r.note }))}
              stations={stations}
              objectives={OBJECTIVES.map(([value, label]) => ({ value, label }))}
            />
          )}
        </div>
      </Section>
    </>
  );
}
