export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { PageHero, Section } from "@/components/ui";
import { ClaimClient } from "./ClaimClient";

export const metadata: Metadata = { title: "Claim your gift", robots: { index: false, follow: false } };

/**
 * Secure gift claim landing (?t=<one-time token>). The page itself needs no session —
 * the token is only ever in the URL; claiming requires sign-in, which the client
 * surfaces as a login prompt. The token is never stored or logged.
 */
export default async function GiftClaimPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t } = await searchParams;
  return (
    <>
      <PageHero eyebrow="Gift credits" title={<>Claim your gift.</>}>
        <p>You&apos;ve been sent Zapnivo charging credit. Claim it below to add it to your account.</p>
      </PageHero>
      <Section className="pt-14">
        <div className="mx-auto max-w-md rounded-xl bg-white p-6 md:p-10">
          <ClaimClient token={typeof t === "string" ? t : ""} />
        </div>
      </Section>
    </>
  );
}
