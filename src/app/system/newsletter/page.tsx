export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getNewsletterOverview, type NewsletterDelivery } from "@/lib/newsletter/service";
import { getEmailDeliveryWebhookStatus } from "@/lib/newsletter/delivery-events";
import { ResendButton } from "./ResendButton";
import { TestSendForm } from "./TestSendForm";

export const metadata: Metadata = { title: "Newsletter — Subscribers" };

const statusBadge = (s: string) =>
  s === "confirmed"
    ? "bg-lime/15 text-lime ring-lime/30"
    : s === "pending"
      ? "bg-amber-400/10 text-amber-300 ring-amber-300/30"
      : "bg-white/10 text-slate-300 ring-white/15";

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

/** Outbox delivery badge — 'sent' means provider-accepted only until a webhook event confirms more. */
const deliveryBadge = (d: NewsletterDelivery | null, ev: { eventType: string; occurredAt: string; provider: string } | null = null) => {
  // Webhook-confirmed terminal states outrank the outbox badge.
  if (ev?.eventType === "delivered") {
    return (
      <span title={`${ev.provider} · delivered ${fmtDate(ev.occurredAt)}`} className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider text-emerald-300 ring-1 ring-emerald-400/30">
        delivered
      </span>
    );
  }
  if (ev && ["hard_bounce", "complaint", "failed"].includes(ev.eventType)) {
    return (
      <span title={`${ev.provider} · ${ev.eventType} ${fmtDate(ev.occurredAt)}`} className="rounded-full bg-red-400/10 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider text-red-300 ring-1 ring-red-400/30">
        {ev.eventType === "complaint" ? "complaint" : "bounced"}
      </span>
    );
  }
  if (!d) return <span className="text-slate-600">—</span>;
  const cls =
    d.status === "sent"
      ? "bg-lime/15 text-lime ring-lime/30"
      : d.status === "failed"
        ? "bg-red-400/10 text-red-300 ring-red-400/30"
        : "bg-sky-400/10 text-sky-300 ring-sky-400/25";
  const label = d.status === "sent" ? "sent" : d.status === "failed" ? "delivery failed" : "queued";
  return (
    <span title={`${d.event ?? "email"} · ${fmtDate(d.at)}`} className={`rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider ring-1 ${cls}`}>
      {label}
    </span>
  );
};

/**
 * /system/newsletter — subscriber pipeline overview. Pending rows are shown for
 * follow-up but are NOT counted as subscribers (double opt-in is not complete
 * until the confirm link is used).
 */
export default async function NewsletterAdminPage() {
  const db = serviceClient();
  const [overview, webhook] = await Promise.all([
    db ? getNewsletterOverview(db) : null,
    getEmailDeliveryWebhookStatus(db),
  ]);

  return (
    <SystemGate perm="system.dashboard.view">
      <div className="space-y-4">
        <div>
          <p className="eyebrow text-lime">Website</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Newsletter subscribers</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Double opt-in pipeline: pending → confirmed via emailed link; unsubscribe is token-based,
            no login. Pending addresses are <span className="text-slate-200">not</span> subscribers yet.
          </p>
        </div>

        {!overview ? (
          <p className="rounded-2xl border border-white/[0.08] bg-white/[0.05] px-6 py-10 text-sm text-slate-400">
            {db ? "Newsletter data unavailable — check migration 0060 and backend health." : "Backend not configured — subscriber data unavailable."}
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {([
                ["Confirmed subscribers", overview.confirmedTotal, "text-lime"],
                ["Pending confirmation", overview.totals.pending, "text-amber-300"],
                ["Unsubscribed", overview.totals.unsubscribed, "text-slate-300"],
                ["Total rows", overview.totals.pending + overview.totals.confirmed + overview.totals.unsubscribed, "text-white"],
              ] as const).map(([label, n, cls]) => (
                <div key={label} className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
                  <p className="text-xs font-bold uppercase tracking-wider text-slate-500">{label}</p>
                  <p className={`mt-1 font-display text-3xl font-bold ${cls}`}>{n.toLocaleString()}</p>
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
              <h2 className="text-sm font-bold text-white">By segment × status</h2>
              <table className="mt-3 w-full text-left text-xs">
                <thead>
                  <tr className="text-slate-500">
                    <th className="pb-2 font-bold uppercase tracking-wider">Segment</th>
                    <th className="pb-2 text-right font-bold uppercase tracking-wider">Pending</th>
                    <th className="pb-2 text-right font-bold uppercase tracking-wider">Confirmed</th>
                    <th className="pb-2 text-right font-bold uppercase tracking-wider">Unsubscribed</th>
                  </tr>
                </thead>
                <tbody>
                  {(["customer", "business", "both"] as const).map((seg) => (
                    <tr key={seg} className="border-t border-white/[0.06] text-slate-300">
                      <td className="py-2 font-bold capitalize">{seg}</td>
                      <td className="py-2 text-right font-mono">{overview.bySegment[seg].pending}</td>
                      <td className="py-2 text-right font-mono text-lime">{overview.bySegment[seg].confirmed}</td>
                      <td className="py-2 text-right font-mono">{overview.bySegment[seg].unsubscribed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
              <h2 className="text-sm font-bold text-white">Delivery webhook status</h2>
              <p className="mt-1 text-xs text-slate-400">
                Provider events arrive at <code className="font-mono">/api/webhooks/email/delivery</code>.
                Setup: <span className="text-slate-300">Resend</span> — dashboard → Webhooks → add the endpoint,
                subscribe to sent/delivered/delivery_delayed/bounced/complained, set{" "}
                <code className="font-mono">RESEND_WEBHOOK_SECRET</code> to the signing secret (svix-verified).
                <span className="text-slate-300"> Brevo</span> — Transactional → Settings → Webhooks → add the
                endpoint with delivered/bounce/spam/unsubscribe events, set <code className="font-mono">BREVO_WEBHOOK_SECRET</code>{" "}
                and configure the webhook <code className="font-mono">headers</code>/<code className="font-mono">auth</code>{" "}
                to send <code className="font-mono">X-Zapnivo-Delivery-Key</code> (preferred — keeps the secret out of URLs).
                The <code className="font-mono">?key=</code> param still works but is deprecated and logs a warning;
                set <code className="font-mono">BREVO_WEBHOOK_ALLOW_QUERY=0</code> once header auth is verified.
                No secret configured → the endpoint answers 503 and processes nothing.
              </p>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
                <div className="rounded-xl border border-white/5 bg-black/20 px-3 py-2">
                  <dt className="text-slate-500">Secrets configured</dt>
                  <dd className="mt-0.5 font-mono text-slate-200">
                    {webhook.resendConfigured || webhook.brevoConfigured
                      ? [webhook.resendConfigured && "resend", webhook.brevoConfigured && "brevo"].filter(Boolean).join(" + ")
                      : "none — webhook disabled"}
                  </dd>
                </div>
                <div className="rounded-xl border border-white/5 bg-black/20 px-3 py-2">
                  <dt className="text-slate-500">Last event</dt>
                  <dd className="mt-0.5 font-mono text-slate-200">
                    {webhook.lastEventAt ? `${webhook.lastEventType ?? "?"} · ${webhook.lastEventProvider ?? "?"} · ${fmtDate(webhook.lastEventAt)}` : "none received"}
                  </dd>
                </div>
                <div className="rounded-xl border border-white/5 bg-black/20 px-3 py-2">
                  <dt className="text-slate-500">Events stored</dt>
                  <dd className="mt-0.5 font-mono text-slate-200">{webhook.totalEvents == null ? "—" : webhook.totalEvents.toLocaleString()}</dd>
                </div>
              </dl>
            </div>

            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.05] p-5">
              <h2 className="text-sm font-bold text-white">Send test DOI</h2>
              <p className="mt-1 text-xs text-slate-400">
                Sends a real confirmation email through the production pipeline. Allowlisted addresses only
                (*@zapnivo.com or <code className="font-mono">NEWSLETTER_TEST_ADDRESSES</code>); the row is marked{" "}
                <code className="font-mono">source=operator_test</code> for cleanup.
              </p>
              <div className="mt-3"><TestSendForm /></div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.05]">
              <div className="border-b border-white/[0.08] px-5 py-4">
                <h2 className="text-sm font-bold text-white">Recent subscribers</h2>
              </div>
              {overview.recent.length === 0 ? (
                <p className="px-5 py-10 text-sm text-slate-400">No newsletter signups yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="text-slate-500">
                        <th className="px-5 py-3 font-bold uppercase tracking-wider">Email</th>
                        <th className="px-3 py-3 font-bold uppercase tracking-wider">Segment</th>
                        <th className="px-3 py-3 font-bold uppercase tracking-wider">Status</th>
                        <th className="px-3 py-3 font-bold uppercase tracking-wider">Delivery</th>
                        <th className="px-3 py-3 font-bold uppercase tracking-wider">Source</th>
                        <th className="px-3 py-3 font-bold uppercase tracking-wider">Created</th>
                        <th className="px-3 py-3 font-bold uppercase tracking-wider">Confirmed</th>
                        <th className="px-5 py-3 font-bold uppercase tracking-wider">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.recent.map((r) => (
                        <tr key={r.id} className="border-t border-white/[0.06] text-slate-300">
                          <td className="px-5 py-3 font-mono text-[11px]">{r.email}</td>
                          <td className="px-3 py-3 capitalize">{r.segment}</td>
                          <td className="px-3 py-3">
                            <span className={`rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wider ring-1 ${statusBadge(r.status)}`}>{r.status}</span>
                          </td>
                          <td className="px-3 py-3">{deliveryBadge(r.delivery, r.deliveryEvent)}</td>
                          <td className="px-3 py-3 text-slate-400">{r.source}</td>
                          <td className="px-3 py-3 text-slate-400">{fmtDate(r.created_at)}</td>
                          <td className="px-3 py-3 text-slate-400">{fmtDate(r.confirmed_at)}</td>
                          <td className="px-5 py-3">{r.status === "pending" ? <ResendButton id={r.id} /> : null}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <p className="text-xs text-slate-500">
              Brevo audience sync activates when <code className="font-mono">NEWSLETTER_BREVO_LIST_ID</code> +{" "}
              <code className="font-mono">BREVO_API_KEY</code> are set; otherwise subscribers live only in Supabase.
            </p>
          </>
        )}
      </div>
    </SystemGate>
  );
}
