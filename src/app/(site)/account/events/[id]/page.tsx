import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Badge, Notice, PageHero, Section } from "@/components/ui";
import { getSessionUser } from "@/lib/auth";
import { EVENT_TRANSITIONS, getEvent, listPasses, type EventPassRow } from "@/lib/events-program";
import { serviceClient } from "@/lib/supabase";
import { EventDetailClient } from "./EventDetailClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Event", robots: { index: false, follow: false } };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—");
const fmtCents = (c: number | null) => (c == null ? "Not priced" : `$${(c / 100).toFixed(2)}`);

const PASS_TONE: Record<string, "lime" | "ink" | "amber"> = {
  active: "lime", redeemed: "ink", expired: "amber", revoked: "ink",
};

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const db = serviceClient();
  if (!db) return <Notice title="Not connected.">Events need the database — Supabase isn&apos;t configured.</Notice>;

  const out = await getEvent(db, user.id, id);
  if (!out.ok) notFound();
  const passesOut = await listPasses(db, user.id, id);
  if (!passesOut.ok) notFound();
  const { event, stats } = out.data;
  const passes = passesOut.data as EventPassRow[];

  return (
    <>
      <PageHero eyebrow="Events" title={event.name}>
        {when(event.starts_at)} → {when(event.ends_at)} · pass price {fmtCents(event.price_cents)} ·{" "}
        <Badge tone={event.status === "active" ? "lime" : "ink"}>{event.status}</Badge>
      </PageHero>
      <Section>
        <div className="space-y-8">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Passes issued", stats.total],
              ["Paid", stats.paid],
              ["Redeemed", stats.redeemed],
              ["Units redeemed", `${stats.unitsUsed}/${stats.unitsGranted}`],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl border border-mist bg-white p-5 shadow-sm">
                <p className="text-xs font-extrabold uppercase tracking-wider text-graphite">{label}</p>
                <p className="mt-1 font-display text-2xl font-bold">{value}</p>
              </div>
            ))}
          </div>

          <EventDetailClient
            event={{
              id: event.id, name: event.name, status: event.status,
              starts_at: event.starts_at, ends_at: event.ends_at,
              price_cents: event.price_cents, max_redemptions: event.max_redemptions,
            }}
            transitions={EVENT_TRANSITIONS[event.status] ?? []}
            passes={passes.map((p) => ({
              id: p.id, status: p.status, units_granted: p.units_granted, units_used: p.units_used,
              paid_at: p.paid_at, expires_at: p.expires_at, created_at: p.created_at,
            }))}
            organizerEmail={user.email}
          />
        </div>
      </Section>
    </>
  );
}
