import type { Metadata } from "next";
import { Button, Eyebrow, Section } from "@/components/ui";
import { MarketingHero } from "@/components/MarketingHero";
import { ScenePhoto } from "@/components/Photo";
import { Locator } from "@/components/Locator";
import { getStations } from "@/lib/stations";

export const revalidate = 300;

export const metadata: Metadata = { title: { absolute: "Find Portable Phone Charger Stations | Zapnivo" }, description: "Explore verified live Zapnivo portable charger rental stations in Minnesota and learn where the network is rolling out." };
export default async function Locations() {
  const stations = await getStations();
  return <>
    <MarketingHero eyebrow="The station network" title={<>Find your next charge.</>} description="Search for a Zapnivo station, check its location, and take portable power with you. We publish each station only after it is installed and verified." actions={<><Button href="#station-finder">Explore the map</Button><Button href="/how-it-works" variant="ghost" className="border-white/40 text-white">How rentals work</Button></>} visual={<ScenePhoto scene="event" />} note="Illustrative render · outdoor event setting" />
    <Section id="station-finder"><div className="mb-10 flex flex-col gap-5 md:flex-row md:items-end md:justify-between"><div><Eyebrow className="text-forest">Station finder</Eyebrow><h2 className="display-lg mt-5">Explore Minnesota.</h2></div><p className="max-w-lg text-graphite">Only live, verified stations appear below. Hours and directions are added with each location.</p></div><Locator stations={stations} /></Section>
    {stations.length === 0 && <Section className="bg-mist"><div className="grid gap-10 lg:grid-cols-[1fr_1fr] lg:items-center"><div><Eyebrow className="text-forest">Rolling out</Eyebrow><h2 className="display-md mt-5">The first pins are coming.</h2><p className="lead mt-5 text-graphite">The network is in its first installation phase. We won't publish a station until guests can actually use it. Check back here as verified locations open.</p></div><div className="rounded-xl bg-forest p-8 text-white"><span className="eyebrow text-lime">Own a venue?</span><h3 className="mt-5 font-display text-3xl font-bold">Help bring the next station to life.</h3><p className="mt-4 text-white/70">Tell us about your location and we can discuss whether Zapnivo is a fit for your guests.</p><div className="mt-7"><Button href="/business/apply">Request a partnership</Button></div></div></div></Section>}
  </>;
}
