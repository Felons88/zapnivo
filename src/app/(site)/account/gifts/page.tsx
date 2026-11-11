export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHero, Section } from "@/components/ui";
import { getSessionUser } from "@/lib/auth";
import { GIFT_PACKAGES, GIFT_PUBLIC_SELECT, giftSalesEnabled, type GiftRow } from "@/lib/gifts";
import { balance } from "@/lib/monetization/entitlements";
import { serviceClient } from "@/lib/supabase";
import { GiftsPanel, type GiftListItem } from "./GiftsPanel";

export const metadata: Metadata = { title: "Gift credits", robots: { index: false, follow: false } };

const toItem = (g: GiftRow): GiftListItem => ({
  id: g.id,
  package: g.package,
  value_cents: g.value_cents,
  recipient_email: g.recipient_email,
  status: g.status,
  created_at: g.created_at,
  expires_at: g.expires_at,
  redeemed_at: g.redeemed_at,
  refunded_at: g.refunded_at,
});

export default async function AccountGifts({ searchParams }: { searchParams: Promise<{ purchase?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const sp = await searchParams;

  let purchased: GiftListItem[] = [];
  let redeemed: GiftListItem[] = [];
  let balanceCents = 0;
  let unavailable = false;
  const db = serviceClient();
  if (db) {
    const [p, r, bal] = await Promise.all([
      db.from("gift_credits").select(GIFT_PUBLIC_SELECT)
        .or(`purchaser_profile.eq.${user.id},purchaser_email.eq.${user.email}`)
        .order("created_at", { ascending: false }).limit(100),
      db.from("gift_credits").select(GIFT_PUBLIC_SELECT)
        .eq("redeemed_by", user.id).order("redeemed_at", { ascending: false }).limit(100),
      balance(db, user.id, "cent"),
    ]);
    if (p.error || r.error) unavailable = true;
    else {
      purchased = ((p.data ?? []) as GiftRow[]).map(toItem);
      redeemed = ((r.data ?? []) as GiftRow[]).map(toItem);
      balanceCents = bal?.cent ?? 0;
    }
  } else {
    unavailable = true;
  }

  return (
    <>
      <PageHero eyebrow="Your account" title={<>Gift charging credit.</>}>
        <p>Buy a gift for a friend, or redeem a code you received. Signed in as {user.email}.</p>
      </PageHero>
      <Section className="pt-14">
        <div className="mx-auto max-w-3xl">
          <GiftsPanel
            packages={GIFT_PACKAGES.map((p) => ({ id: p.id, label: p.label, priceCents: p.priceCents, creditCents: p.creditCents, description: p.description }))}
            salesEnabled={giftSalesEnabled()}
            balanceCents={balanceCents}
            purchased={purchased}
            redeemed={redeemed}
            unavailable={unavailable}
            purchaseResult={sp.purchase}
          />
        </div>
      </Section>
    </>
  );
}
