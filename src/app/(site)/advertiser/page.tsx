import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { Button, Notice, PageHero, Section } from "@/components/ui";
import { getAdvertiserPageContext, type CampaignRow } from "@/lib/ads/service";
import { OrgForm } from "./OrgForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Advertiser dashboard", robots: { index: false, follow: false } };

const money = (cents: number | null) => (cents == null ? "—" : `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

const STATUS_TONE: Record<CampaignRow["status"], "mist" | "lime" | "gold" | "red" | "ink" | "cyan"> = {
  draft: "mist", pending_approval: "gold", approved: "cyan", scheduled: "cyan",
  live: "lime", paused: "gold", taken_down: "red",
};
const PAY_TONE: Record<CampaignRow["payment_status"], string> = {
  unpaid: "unpaid", checkout_pending: "checkout pending", paid: "paid", failed: "payment failed", refunded: "refunded",
};

export default async function AdvertiserDashboard({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: orgParam } = await searchParams;
  const pc = await getAdvertiserPageContext(orgParam ?? null);
  if (pc.kind === "no_user") redirect("/login");

  if (pc.kind === "no_db") {
    return (
      <>
        <PageHero eyebrow="Advertisers" title={<>Your ad campaigns.</>}><p>Signed in as {pc.user.email}.</p></PageHero>
        <Section className="pt-14"><div className="mx-auto max-w-2xl"><Notice title="Not configured yet.">The advertising backend isn't connected in this environment.</Notice></div></Section>
      </>
    );
  }

  if (pc.kind === "no_org") {
    return (
      <>
        <PageHero eyebrow="Advertisers" title={<>Advertise on Zapnivo.</>}><p>Signed in as {pc.user.email}. Create your organization to start building campaigns.</p></PageHero>
        <Section className="pt-14">
          <div className="mx-auto grid max-w-4xl gap-10 lg:grid-cols-[.9fr_1.1fr]">
            <div>
              <h2 className="display-md">Set up your organization</h2>
              <p className="lead mt-4 text-graphite">One account per business. You'll be the owner and can add teammates later. Campaigns go through review before they run.</p>
            </div>
            <div className="rounded-xl bg-white p-6 md:p-8"><OrgForm email={pc.user.email} /></div>
          </div>
        </Section>
      </>
    );
  }

  const { user, org, role, memberships, db } = pc;
  const { data: rows, error } = await db
    .from("advertising_campaigns")
    .select("id,name,status,payment_status,budget_cents,spent_cents,starts_at,ends_at,created_at")
    .eq("advertiser_org_id", org.id)
    .order("created_at", { ascending: false })
    .limit(100);
  const campaigns = (rows ?? []) as unknown as Pick<CampaignRow, "id" | "name" | "status" | "payment_status" | "budget_cents" | "spent_cents" | "starts_at" | "ends_at" | "created_at">[];
  const unavailable = !!error;
  const live = campaigns.filter((c) => c.status === "live" || c.status === "approved" || c.status === "scheduled").length;
  const pending = campaigns.filter((c) => c.status === "pending_approval").length;
  const spent = campaigns.reduce((s, c) => s + (c.spent_cents ?? 0), 0);

  return (
    <>
      <PageHero eyebrow="Advertiser dashboard" title={<>Campaigns for {org.name}.</>}>
        <p>Signed in as {user.email} · role: {role}{org.status !== "active" ? ` · organization ${org.status}` : ""}</p>
      </PageHero>
      <Section className="pt-14">
        <div className="space-y-8">
          {memberships.length > 1 && (
            <nav aria-label="Organizations" className="flex flex-wrap gap-2">
              {memberships.map((m) => (
                <Link key={m.org.id} href={`/advertiser?org=${m.org.id}`}
                  className={`rounded-full px-4 py-2 text-sm font-bold ${m.org.id === org.id ? "bg-ink text-white" : "bg-white hover:bg-mist"}`}>
                  {m.org.name}
                </Link>
              ))}
            </nav>
          )}

          {unavailable ? (
            <Notice title="Campaigns aren't loading.">Please refresh in a moment.</Notice>
          ) : (
            <>
              <section aria-label="Metrics" className="grid gap-4 sm:grid-cols-3">
                <Metric label="Active campaigns" value={live} />
                <Metric label="Pending review" value={pending} sub="Submitted, awaiting approval" />
                <Metric label="Spent to date" value={money(spent)} />
              </section>

              <section aria-label="Campaigns" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-mist px-6 py-4">
                  <h2 className="font-display text-lg font-bold">Your campaigns</h2>
                  <Button href="/advertiser/campaigns/new" className="min-h-10 px-5 text-sm">New campaign</Button>
                </div>
                {campaigns.length === 0 ? (
                  <div className="px-6 py-10">
                    <p className="font-bold">No campaigns yet.</p>
                    <p className="mt-1 text-sm text-graphite">Build your first campaign — pick placements, markets and a schedule, then add creatives for review.</p>
                    <div className="mt-4"><Button href="/advertiser/campaigns/new" className="min-h-10 px-5 text-sm">New campaign</Button></div>
                  </div>
                ) : (
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                      <tr>{["Campaign", "Status", "Schedule", "Budget", "Payment"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {campaigns.map((c) => (
                        <tr key={c.id} className="border-b border-mist/70 last:border-0 hover:bg-mist/30">
                          <td className="px-4 py-3"><Link href={`/advertiser/campaigns/${c.id}`} className="font-bold underline underline-offset-4">{c.name}</Link></td>
                          <td className="px-4 py-3"><Pill tone={STATUS_TONE[c.status] ?? "mist"}>{c.status.replace(/_/g, " ")}</Pill></td>
                          <td className="px-4 py-3 text-xs text-graphite">{when(c.starts_at)} → {when(c.ends_at)}</td>
                          <td className="px-4 py-3 font-display font-bold">{money(c.budget_cents)}</td>
                          <td className="px-4 py-3 text-xs font-semibold text-graphite">{PAY_TONE[c.payment_status] ?? c.payment_status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </>
          )}
        </div>
      </Section>
    </>
  );
}
