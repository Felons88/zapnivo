import type { Metadata } from "next";
import { Badge, Notice, PageHero, Section } from "@/components/ui";
import { decideAvailability, STATION_ID_RE, type KioskVenueRow } from "@/lib/customer";
import { fmt, PRICING_V1 } from "@/lib/pricing";
import { getStations } from "@/lib/stations";
import { serviceClient } from "@/lib/supabase";
import { RentForm } from "./RentForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Rent a power bank", robots: { index: false, follow: false } };

export default async function StationPage({ params, searchParams }: { params: Promise<{ station: string }>; searchParams: Promise<{ status?: string }> }) {
  const { station } = await params;
  const { status } = await searchParams;
  const db = serviceClient();
  let row: KioskVenueRow = null;
  if (db && STATION_ID_RE.test(station)) {
    const { data } = await db
      .from("kiosks")
      .select("station_id,state,installed_at,venues(name,street,city,state,zip,hours,published)")
      .eq("station_id", station)
      .maybeSingle();
    row = (data as unknown as KioskVenueRow) ?? null;
  }
  const avail = decideAvailability(row, Boolean(db));
  const others = (await getStations()).filter((s) => s.id !== station);
  const P = PRICING_V1;

  return (
    <>
      <PageHero eyebrow="Zapnivo station" title={<>Rent a power bank.</>}>
        <p>Return it to any Zapnivo station.</p>
      </PageHero>
      <Section className="pt-14">
        <div className="mx-auto max-w-2xl space-y-8">
          {status === "success" && <div role="status"><Notice title="Payment received.">Thank you. Your rental will start at the station once it is confirmed. A receipt will be emailed to you.</Notice></div>}
          {status === "cancelled" && <div role="status"><Notice title="Checkout cancelled.">You have not been charged. You can start again below.</Notice></div>}

          {avail.ok ? (
            <>
              <div className="rounded-xl bg-white p-6">
                <h2 className="text-lg font-bold">{avail.venueName}</h2>
                <p className="mt-1 text-graphite">{avail.address}</p>
                {avail.hours && <p className="mt-1 text-sm text-graphite">Hours: {avail.hours}</p>}
              </div>
              <div className="rounded-xl bg-white p-6">
                <Badge tone="amber">Proposed pilot pricing</Badge>
                <ul className="mt-4 space-y-1 text-graphite">
                  <li>First hour: {fmt(P.firstHourCents)}</li>
                  <li>Each additional hour: {fmt(P.additionalHourCents)}</li>
                  <li>24-hour maximum: {fmt(P.first24hCapCents)}</li>
                </ul>
                <div className="mt-4"><Notice title="Final pricing pending.">These figures may change before rentals go live. Applicable taxes are added at checkout; a temporary payment authorization may apply.</Notice></div>
              </div>
              <div className="rounded-xl bg-white p-6 md:p-8"><RentForm stationId={station} /></div>
            </>
          ) : (
            <div role="status" className="rounded-xl bg-white p-6 md:p-8">
              <h2 className="text-lg font-bold">This station is unavailable right now.</h2>
              <p className="mt-2 text-graphite">
                {avail.reason === "unconfigured"
                  ? "Rentals aren't open yet."
                  : "We can't confirm this station is ready for rentals. Please try another Zapnivo station, or contact us if you think this is a mistake."}
              </p>
            </div>
          )}

          <div className="rounded-xl bg-white p-6 md:p-8">
            <h2 className="text-lg font-bold">Return anywhere</h2>
            <p className="mt-1 text-sm text-graphite">Stations where you can return a power bank.</p>
            {others.length === 0 ? (
              <p className="mt-4 text-graphite">No other stations are live yet. We only list stations that are installed and verified.</p>
            ) : (
              <ul className="mt-4 divide-y divide-mist">
                {others.map((s) => (
                  <li key={s.id} className="py-3">
                    <p className="font-bold">{s.name}</p>
                    <p className="text-sm text-graphite">{s.address}</p>
                    {s.hours && <p className="text-sm text-graphite">Hours: {s.hours}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Section>
    </>
  );
}
