import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Notice, PageHero, Section } from "@/components/ui";
import { getSessionUser } from "@/lib/auth";
import { listGroups, listMemberGroups, type GroupRow } from "@/lib/groups";
import { serviceClient } from "@/lib/supabase";
import { GroupsManager } from "./GroupsManager";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Rental groups", robots: { index: false, follow: false } };

const fmtCents = (c: number) => `$${(c / 100).toFixed(2)}`;
const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium" });

function GroupCard({ g, organizer }: { g: GroupRow; organizer: boolean }) {
  return (
    <Link href={`/account/groups/${g.id}`} className="block rounded-2xl border border-mist bg-white p-5 shadow-sm transition hover:border-ink/30">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-bold">{g.name}</h3>
          <p className="mt-1 text-xs text-graphite">
            {organizer ? "You organize" : "Member"} · created {when(g.created_at)}
          </p>
        </div>
        <Badge tone={g.status === "active" ? "lime" : "ink"}>{g.status}</Badge>
      </div>
      <p className="mt-3 text-sm text-graphite">
        Shared credit pool: <strong className="text-ink">{fmtCents(g.credit_cents)}</strong>
        {" · "}max {g.max_members} members
      </p>
    </Link>
  );
}

export default async function GroupsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const db = serviceClient();
  const groups = db ? await listGroups(db, user.id) : [];
  const memberships = db ? await listMemberGroups(db, user.id) : [];

  return (
    <>
      <PageHero eyebrow="Account" title="Rental groups">
        Organize a crew, club, or event crew — invite members by email and share a prepaid credit pool.
        Everyone still checks out individually at any station; there&apos;s no simultaneous dispensing.
      </PageHero>
      <Section>
        <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <h2 className="font-display text-xl font-bold">Your groups</h2>
            {db ? (
              groups.length === 0
                ? <p className="rounded-2xl border border-dashed border-silver/60 p-6 text-sm text-graphite">No groups yet — create one on the right.</p>
                : <div className="grid gap-4 sm:grid-cols-2">{groups.map((g) => <GroupCard key={g.id} g={g} organizer />)}</div>
            ) : <Notice title="Not connected.">Groups need the database — Supabase isn&apos;t configured in this environment.</Notice>}

            {memberships.length > 0 && (
              <>
                <h2 className="pt-4 font-display text-xl font-bold">Groups you&apos;ve joined</h2>
                <p className="text-sm text-graphite">Pool balance is read-only for members. To spend it, use the normal checkout at a station.</p>
                <div className="grid gap-4 sm:grid-cols-2">{memberships.map((g) => <GroupCard key={g.id} g={g} organizer={false} />)}</div>
              </>
            )}
          </div>
          <div>
            <GroupsManager />
          </div>
        </div>
        <p className="mt-10 text-xs text-graphite">
          Members rent like anyone else — each person checks out on their own at <Link href="/locations" className="font-bold underline">a station</Link>.
          The shared pool is informational until self-serve funding ships; staff can adjust it from the admin console.
        </p>
      </Section>
    </>
  );
}
