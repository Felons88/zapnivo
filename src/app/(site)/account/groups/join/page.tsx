import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Notice, PageHero, Section } from "@/components/ui";
import { getSessionUser } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";
import { JoinGroupForm } from "./JoinGroupForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Join a group", robots: { index: false, follow: false } };

export default async function JoinGroupPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const sp = await searchParams;
  const db = serviceClient();
  if (!db) return <Notice title="Not connected.">Groups need the database — Supabase isn&apos;t configured.</Notice>;

  return (
    <>
      <PageHero eyebrow="Rental groups" title="Join a group">
        Accept your invite to become an active member. You&apos;ll still rent individually at any station.
      </PageHero>
      <Section>
        <div className="mx-auto max-w-md">
          <JoinGroupForm initialToken={sp.token ?? ""} />
        </div>
      </Section>
    </>
  );
}
