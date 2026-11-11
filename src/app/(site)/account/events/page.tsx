import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Notice, PageHero, Section } from "@/components/ui";
import { getSessionUser } from "@/lib/auth";
import { listEvents, type EventRow } from "@/lib/events-program";
import { serviceClient } from "@/lib/supabase";
import { EventForm } from "./EventForm";
import { RedeemPassForm } from "./RedeemPassForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Events", robots: { index: false, follow: false } };

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
const fmtCents = (c: number | null) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);

const STATUS_TONE: Record<string, "lime" | "ink" | "amber"> = {
  draft: "ink", active: "lime", paused: "amber", closed: "ink", cancelled: "ink",
};

function EventCard({ e }: { e: EventRow }) {
  return (
    <Link href={`/account/events/${e.id}`} className="block rounded-2xl border border-mist bg-white p-5 shadow-sm transition hover:border-ink/30">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-bold">{e.name}</h3>
          <p className="mt-1 text-xs text-graphite">{when(e.starts_at)} → {when(e.ends_at)}</p>
        </div>
        <Badge tone={STATUS_TONE[e.status] ?? "ink"}>{e.status}</Badge>
      </div>
      <p className="mt-3 text-sm text-graphite">Pass price: <strong className="text-ink">{fmtCents(e.price_cents)}</strong></p>
    </Link>
  );
}

export default async function EventsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const db = serviceClient();

  const [events, venuesRes, packagesRes] = db
    ? await Promise.all([
        listEvents(db, user.id),
        db.from("venues").select("id,name,city").order("name").limit(200),
        db.from("prepaid_packages").select("id,name").eq("active", true).order("sort").limit(100),
      ])
    : [[], null, null];
  const venues = ((venuesRes?.data ?? []) as { id: string; name: string; city: string | null }[])
    .map((v) => ({ id: v.id, label: v.city ? `${v.name} — ${v.city}` : v.name }));
  const packages = ((packagesRes?.data ?? []) as { id: string; name: string }[]);

  return (
    <>
      <PageHero eyebrow="Account" title="Events">
        Run a charging event — issue prepaid passes, attendees redeem a code during the event window
        for rental credits they spend like normal.
      </PageHero>
      <Section>
        <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="space-y-8">
            <div>
              <h2 className="font-display text-xl font-bold">Your events</h2>
              {db ? (
                events.length === 0
                  ? <p className="mt-3 rounded-2xl border border-dashed border-silver/60 p-6 text-sm text-graphite">No events yet — create one on the right.</p>
                  : <div className="mt-4 grid gap-4 sm:grid-cols-2">{events.map((e) => <EventCard key={e.id} e={e} />)}</div>
              ) : <div className="mt-3"><Notice title="Not connected.">Events need the database — Supabase isn&apos;t configured in this environment.</Notice></div>}
            </div>
            <div>
              <h2 className="font-display text-xl font-bold">Have a pass code?</h2>
              <p className="mt-1 text-sm text-graphite">Redeem it during the event window to load rental credits onto your account.</p>
              <div className="mt-4"><RedeemPassForm /></div>
            </div>
          </div>
          <div>{db ? <EventForm venues={venues} packages={packages} /> : <Notice title="Not connected.">Events need the database — Supabase isn&apos;t configured.</Notice>}</div>
        </div>
        <p className="mt-10 text-xs text-graphite">
          Passes are bearer codes — anyone holding a paid, unredeemed code can claim it during the event window.
          Redemption grants rental credits; each rental still checks out individually at a station.
        </p>
      </Section>
    </>
  );
}
