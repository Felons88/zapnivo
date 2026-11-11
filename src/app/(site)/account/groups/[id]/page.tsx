import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Notice, PageHero, Section } from "@/components/ui";
import { getSessionUser } from "@/lib/auth";
import { getGroup, type GroupMemberRow } from "@/lib/groups";
import { serviceClient } from "@/lib/supabase";
import { GroupDetailClient } from "./GroupDetailClient";
import { RemoveMemberButton } from "./RemoveMemberButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Group", robots: { index: false, follow: false } };

const fmtCents = (c: number) => `$${(c / 100).toFixed(2)}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—");

export default async function GroupPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { id } = await params;
  const db = serviceClient();
  if (!db) return <Notice title="Not connected.">Groups need the database — Supabase isn&apos;t configured.</Notice>;
  const out = await getGroup(db, user.id, id);
  if (!out.ok) notFound();
  const { group, members, counts } = out.data;

  // Resolve member profile emails for display (organizer-only view).
  const profileIds = members.map((m) => m.profile_id).filter((p): p is string => Boolean(p));
  const { data: profiles } = profileIds.length
    ? await db.from("profiles").select("id,email").in("id", profileIds)
    : { data: [] as { id: string; email: string | null }[] };
  const emailBy = new Map(((profiles ?? []) as { id: string; email: string | null }[]).map((p) => [p.id, p.email]));

  const label = (m: GroupMemberRow) =>
    m.profile_id ? (emailBy.get(m.profile_id) ?? "Member") : (m.invite_email ?? "Invited");

  return (
    <>
      <PageHero eyebrow="Rental groups" title={group.name}>
        Shared credit pool: <strong>{fmtCents(group.credit_cents)}</strong> · max {group.max_members} members ·{" "}
        <Badge tone={group.status === "active" ? "lime" : "ink"}>{group.status}</Badge>
      </PageHero>
      <Section>
        <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div>
            <h2 className="font-display text-xl font-bold">Members ({counts.active + counts.invited}/{group.max_members})</h2>
            <ul className="mt-4 divide-y divide-mist rounded-2xl border border-mist bg-white">
              {members.filter((m) => m.status !== "removed").map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 px-5 py-3.5 text-sm">
                  <div>
                    <p className="font-bold">{label(m)}</p>
                    <p className="text-xs text-graphite">joined {when(m.joined_at)}{m.invite_email && !m.profile_id ? " · invite pending" : ""}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge tone={m.status === "active" ? "lime" : "ink"}>{m.status}</Badge>
                    {group.status === "active" && (
                      <RemoveMemberButton groupId={group.id} memberId={m.id} />
                    )}
                  </div>
                </li>
              ))}
              {members.filter((m) => m.status !== "removed").length === 0 && (
                <li className="px-5 py-6 text-sm text-graphite">No members yet — invite someone below.</li>
              )}
            </ul>
            <p className="mt-4 text-sm text-graphite">
              Members rent individually — each person checks out on their own at{" "}
              <Link href="/locations" className="font-bold underline">any station</Link>. There&apos;s no simultaneous dispensing.
            </p>
          </div>
          <GroupDetailClient groupId={group.id} status={group.status} creditCents={group.credit_cents} maxMembers={group.max_members} name={group.name} />
        </div>
      </Section>
    </>
  );
}
