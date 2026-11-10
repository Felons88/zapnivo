import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Notice, PageHero, Section } from "@/components/ui";
import { Pill } from "@/components/SupportNav";
import { getAdvertiserPageContext, getCampaign, type CampaignRow } from "@/lib/ads/service";
import { serviceClient } from "@/lib/supabase";
import { CampaignActions } from "./CampaignActions";
import { CreativeForm } from "./CreativeForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Campaign", robots: { index: false, follow: false } };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeZone: "America/Chicago" }) : "—");
const money = (cents: number | null) => (cents == null ? "—" : `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);

const STATUS_TONE: Record<CampaignRow["status"], "mist" | "lime" | "gold" | "red" | "ink" | "cyan"> = {
  draft: "mist", pending_approval: "gold", approved: "cyan", scheduled: "cyan",
  live: "lime", paused: "gold", taken_down: "red",
};
const CREATIVE_TONE: Record<string, "mist" | "lime" | "gold" | "red" | "ink" | "cyan"> = {
  draft: "mist", submitted: "gold", approved: "lime", rejected: "red", archived: "mist",
};

type Creative = {
  id: string; kind: string; mime: string | null; bytes: number | null;
  headline: string | null; body: string | null; destination_url: string | null;
  status: string; review_note: string | null; created_at: string;
};

const TIMELINE: { key: keyof Pick<CampaignRow, "created_at" | "submitted_at" | "approved_at" | "activated_at">; label: string }[] = [
  { key: "created_at", label: "Draft created" },
  { key: "submitted_at", label: "Submitted for review" },
  { key: "approved_at", label: "Approved" },
  { key: "activated_at", label: "Live" },
];

export default async function CampaignDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pc = await getAdvertiserPageContext();
  if (pc.kind === "no_user") redirect("/login");
  if (pc.kind === "no_org") redirect("/advertiser");
  if (pc.kind !== "ok") notFound();

  const db = serviceClient();
  const campaign = await getCampaign(pc.db, id);
  // Org scoping: the campaign must belong to one of the user's orgs.
  if (!campaign || !campaign.advertiser_org_id || !pc.memberships.some((m) => m.org.id === campaign.advertiser_org_id)) notFound();
  const membership = pc.memberships.find((m) => m.org.id === campaign.advertiser_org_id) ?? null;
  if (!membership) notFound();

  const { data: creativeRows } = db
    ? await db.from("ad_creatives").select("id,kind,mime,bytes,headline,body,destination_url,status,review_note,created_at").eq("campaign_id", campaign.id).order("created_at", { ascending: false }).limit(100)
    : { data: null };
  const creatives = (creativeRows ?? []) as unknown as Creative[];
  const hasSubmittable = creatives.some((c) => c.status === "submitted" || c.status === "approved");

  return (
    <>
      <PageHero eyebrow="Advertiser dashboard" title={<>{campaign.name}</>}>
        <p>{campaign.advertiser} · {campaign.objective?.replace(/_/g, " ") ?? "campaign"} · budget {money(campaign.budget_cents)} · pricing {campaign.pricing_model.replace(/_/g, " ")}</p>
      </PageHero>
      <Section className="pt-14">
        <div className="space-y-8">
          <p><Link href="/advertiser" className="text-sm font-bold text-forest hover:underline">← All campaigns</Link></p>

          <section aria-label="Status" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center gap-3">
              <Pill tone={STATUS_TONE[campaign.status] ?? "mist"}>{campaign.status.replace(/_/g, " ")}</Pill>
              <span className="text-sm text-graphite">payment: {campaign.payment_status.replace(/_/g, " ")}{campaign.spent_cents ? ` · spent ${money(campaign.spent_cents)}` : ""}</span>
            </div>
            <ol className="mt-5 grid gap-3 sm:grid-cols-4">
              {TIMELINE.map((t) => {
                const at = campaign[t.key];
                const done = !!at;
                return (
                  <li key={t.key} className={`rounded-xl border p-4 ${done ? "border-lime bg-mist/40" : "border-mist"}`}>
                    <p className="text-xs font-extrabold uppercase tracking-wider text-graphite">{t.label}</p>
                    <p className="mt-1 text-sm font-bold">{done ? when(at) : "Pending"}</p>
                  </li>
                );
              })}
            </ol>
            {campaign.review_note && <p className="mt-4 rounded-lg bg-[#fff6d6] p-3 text-sm text-[#5b4300]"><b>Reviewer note:</b> {campaign.review_note}</p>}
            <div className="mt-5">
              <CampaignActions
                campaignId={campaign.id}
                status={campaign.status}
                paymentStatus={campaign.payment_status}
                canSubmit={campaign.status === "draft" && hasSubmittable && !!campaign.budget_cents && campaign.budget_cents > 0}
              />
            </div>
          </section>

          <section aria-label="Creatives" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h2 className="font-display text-lg font-bold">Creatives</h2>
            {creatives.length === 0 ? (
              <p className="mt-3 text-sm text-graphite">No creatives yet. Add at least one before submitting for review.</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {creatives.map((c) => (
                  <li key={c.id} className="rounded-xl border border-mist p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-bold">
                        {c.kind === "text" ? (c.headline || "Text creative") : `${c.kind === "video" ? "Video" : "Image"} · ${c.mime ?? "file"}`}
                        {c.bytes ? <span className="ml-2 text-xs font-medium text-graphite">{(c.bytes / 1024 / 1024).toFixed(1)} MB</span> : null}
                      </p>
                      <Pill tone={CREATIVE_TONE[c.status] ?? "mist"}>{c.status}</Pill>
                    </div>
                    {c.body && <p className="mt-2 text-sm text-graphite">{c.body}</p>}
                    {c.destination_url && <p className="mt-1 text-xs"><a className="font-bold text-forest underline" href={c.destination_url} rel="noreferrer">{c.destination_url}</a></p>}
                    {c.review_note && <p className="mt-2 text-xs text-graphite"><b>Review note:</b> {c.review_note}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {membership && (
            <section aria-label="Add creative" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h2 className="font-display text-lg font-bold">Add a creative</h2>
              <p className="mt-1 text-sm text-graphite">Images up to 5 MB (PNG/JPEG/WebP), videos up to 50 MB (MP4), or text with a destination link. Creatives are reviewed before they run.</p>
              <div className="mt-4"><CreativeForm campaignId={campaign.id} locked={!["draft", "pending_approval"].includes(campaign.status)} /></div>
            </section>
          )}
        </div>
      </Section>
    </>
  );
}
