import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHero, Section } from "@/components/ui";
import { getSessionUser } from "@/lib/auth";
import { IncidentForm } from "./IncidentForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Report a problem", robots: { index: false, follow: false } };

export default async function Incident({ searchParams }: { searchParams: Promise<{ rental?: string }> }) {
  const { rental } = await searchParams;
  const ref = (rental ?? "").toUpperCase();
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <>
      <PageHero eyebrow="Your account" title={<>Report a problem.</>}><p>Lost, damaged or stolen charger? Tell us and our team will follow up by email.</p></PageHero>
      <Section className="pt-14">
        <div className="mx-auto max-w-xl rounded-xl bg-white p-6 md:p-10"><IncidentForm rental={ref} /></div>
      </Section>
    </>
  );
}
