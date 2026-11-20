export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AdminGate } from "@/components/AdminShell";
import { Pill } from "@/components/SupportNav";
import { getSessionUser, isStaff } from "@/lib/auth";
import { fmt } from "@/lib/pricing";
import { stripeCall, stripeConfigured } from "@/lib/stripe";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Rental detail", robots: { index: false, follow: false } };

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
const STATE_TONE = { active: "lime", dispense_pending: "cyan", authorized: "cyan", payment_authorized: "cyan", return_pending: "cyan", returned: "mist", closed: "mist", unreturned: "red", overdue: "red", cancelled: "mist", charged_off: "gold", non_return_fee_pending: "gold", disputed: "red" } as const;
const btn = "min-h-9 rounded-full px-3.5 text-xs font-bold";

type PaymentRow = {
  id: string; state: string; amount_authorized_cents: number | null; amount_captured_cents: number | null;
  amount_refunded_cents: number | null; tax_cents: number | null; discount_cents: number | null;
  credit_cents: number | null; currency: string | null; receipt_email: string | null; customer_phone: string | null;
  failure_code: string | null; stripe_payment_intent_id: string | null; stripe_checkout_session_id: string | null;
  created_at: string; captured_at: string | null;
};
type Card = { brand: string; last4: string; funding: string | null };

/** Resolves the card brand/last4 used for this payment from Stripe. Honest null — never a placeholder card. */
async function paymentCard(pay: PaymentRow): Promise<Card | null> {
  if (!stripeConfigured()) return null;
  let piId = pay.stripe_payment_intent_id;
  if (!piId && pay.stripe_checkout_session_id) {
    const s = await stripeCall<{ payment_intent?: string | { id: string } | null }>("GET", `/checkout/sessions/${encodeURIComponent(pay.stripe_checkout_session_id)}`);
    const pi = s.ok ? s.data.payment_intent : null;
    piId = typeof pi === "string" ? pi : pi?.id ?? null;
  }
  if (!piId) return null;
  const r = await stripeCall<{ payment_method?: string | { card?: { brand?: string; last4?: string; funding?: string } } | null }>(
    "GET", `/payment_intents/${encodeURIComponent(piId)}?expand[]=payment_method`);
  const card = r.ok && typeof r.data.payment_method === "object" ? r.data.payment_method?.card : null;
  return card?.brand && card.last4 ? { brand: card.brand, last4: card.last4, funding: card.funding ?? null } : null;
}

/** How the customer paid — derived from which Stripe object exists, no guessing. */
function channel(pay: PaymentRow): string {
  if (pay.stripe_payment_intent_id && !pay.stripe_checkout_session_id) return "In-app card entry (PaymentSheet)";
  if (pay.stripe_checkout_session_id) return "Stripe hosted Checkout";
  return "No Stripe charge yet";
}

export default async function RentalDetail({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isStaff(user)) redirect("/partners");
  const isAdmin = user.role === "admin";
  const { id } = await params;
  const db = serviceClient();
  if (!db) return <AdminGate title="Rental" nav="rentals"><p className="rounded-2xl border border-[#e3e8ee] bg-white p-4 text-sm">Rental data not connected.</p></AdminGate>;

  const { data: raw } = await db.from("rentals")
    .select("id,reference,state,customer_id,renter_profile,kiosk_id,return_kiosk_id,power_bank_id,pricing_version,bank_count,promo_code,sms_consent,accrued_charge_cents,non_return_fee_status,return_disputed,paused_at,paused_seconds,started_at,dispensed_at,returned_at,non_return_deadline,created_at,kiosks!rentals_kiosk_id_fkey(station_id,test_mode,venues(name,city,state)),power_banks(serial)")
    .eq("id", id).maybeSingle();
  const r = raw as Record<string, unknown> | null;
  if (!r) notFound();

  const kiosk = r.kiosks as { station_id: string; test_mode: boolean | null; venues: { name: string; city: string; state: string } | null } | null;
  const bank = r.power_banks as { serial: string } | null;
  const pid = (r.customer_id ?? r.renter_profile) as string | null;

  const [paymentsRes, profileRes, returnKioskRes, refundReqsRes] = await Promise.all([
    db.from("payments").select("*").eq("rental_id", r.id as string).order("created_at", { ascending: true }),
    pid ? db.from("profiles").select("id,email,full_name,phone,role").eq("id", pid).maybeSingle() : Promise.resolve({ data: null }),
    r.return_kiosk_id ? db.from("kiosks").select("station_id,venues(name,city)").eq("id", r.return_kiosk_id as string).maybeSingle() : Promise.resolve({ data: null }),
    db.from("refund_requests").select("id,rental_ref,reason,amount_cents,status,created_at").eq("rental_ref", r.reference as string),
  ]);
  const payments = (paymentsRes.data ?? []) as PaymentRow[];
  const profile = profileRes.data as { id: string; email: string; full_name: string | null; phone: string | null; role: string } | null;
  const returnKiosk = returnKioskRes.data as { station_id: string; venues: { name: string; city: string } | null } | null;

  // Payment-scoped rows resolve once we know the payment ids.
  const payIds = payments.map((p) => p.id);
  const [refunds2, disputes2] = payIds.length ? await Promise.all([
    db.from("refunds").select("id,payment_id,amount_cents,reason,stripe_refund_id,created_at").in("payment_id", payIds),
    db.from("disputes").select("id,payment_id,stripe_dispute_id,status,reason,amount_cents,opened_at,resolved_at,evidence_due_by").in("payment_id", payIds),
  ]) : [{ data: [] }, { data: [] }];
  const refundReqs = (refundReqsRes.data ?? []) as { id: string; rental_ref: string; reason: string; amount_cents: number | null; status: string; created_at: string }[];
  const refunds = (refunds2.data ?? []) as { id: string; payment_id: string; amount_cents: number; reason: string | null; stripe_refund_id: string | null; created_at: string }[];
  const disputes = (disputes2.data ?? []) as { id: string; payment_id: string; stripe_dispute_id: string | null; status: string | null; reason: string | null; amount_cents: number | null; opened_at: string; resolved_at: string | null; evidence_due_by: string | null }[];

  // Card per payment (Stripe lookup — sequential, at most a handful).
  const cards = new Map<string, Card | null>();
  for (const p of payments) cards.set(p.id, await paymentCard(p));

  const email = profile?.email ?? payments.find((p) => p.receipt_email)?.receipt_email ?? null;
  const phone = profile?.phone ?? payments.find((p) => p.customer_phone)?.customer_phone ?? null;
  const back = `/admin/rentals/${r.id}`;
  const overdue = !!r.non_return_deadline && !r.returned_at && new Date(r.non_return_deadline as string) < new Date();

  // Chronological timeline — real timestamps only.
  const timeline = [
    { at: r.created_at as string, label: "Rental created", detail: `${r.bank_count} bank${r.bank_count === 1 ? "" : "s"} · ${kiosk?.station_id ?? "—"}` },
    ...payments.map((p) => ({ at: p.created_at, label: `Hold authorized — ${fmt(p.amount_authorized_cents ?? 0)}`, detail: channel(p) })),
    ...(r.paused_at ? [{ at: r.paused_at as string, label: "Billing paused", detail: `${Math.floor(((r.paused_seconds as number) ?? 0) / 60)} min paused total` }] : []),
    ...(r.dispensed_at ? [{ at: r.dispensed_at as string, label: "Bank dispensed", detail: bank ? `Serial ${bank.serial}` : kiosk?.test_mode ? "Simulated" : "By kiosk" }] : []),
    ...(r.returned_at ? [{ at: r.returned_at as string, label: "Returned", detail: returnKiosk ? `${returnKiosk.venues?.name ?? returnKiosk.station_id}` : "Docked" }] : []),
    ...payments.filter((p) => p.captured_at).map((p) => ({ at: p.captured_at!, label: `Captured — ${fmt(p.amount_captured_cents ?? 0)}`, detail: (p.amount_refunded_cents ?? 0) > 0 ? `${fmt(p.amount_refunded_cents!)} refunded` : "Settled" })),
    ...refunds.map((x) => ({ at: x.created_at, label: `Refund issued — ${fmt(x.amount_cents)}`, detail: x.reason ?? "—" })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex items-baseline justify-between gap-4 border-b border-[#e3e8ee]/70 py-2 last:border-0"><dt className="text-sm text-graphite">{k}</dt><dd className="text-right text-sm font-bold">{v}</dd></div>
  );
  const input = "min-h-9 rounded-lg border border-silver/60 px-2 text-xs font-semibold";

  return (
    <AdminGate title={`Rental ${r.reference}`} nav="rentals">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/admin/rentals" className="text-sm font-bold text-graphite hover:text-ink">← All rentals</Link>
          <span className="text-xs font-bold uppercase tracking-widest text-graphite">Staff only · live rental record</span>
        </div>

        {/* Identity banner */}
        <section className="overflow-hidden rounded-2xl bg-[#142126] text-white shadow-sm">
          <div className="border-b border-white/10 px-4 py-2 text-[10px] font-extrabold uppercase tracking-[.18em] text-[#635bff]">Rental record</div>
          <div className="flex flex-wrap items-start justify-between gap-4 p-4 ">
            <div>
              <p className="eyebrow text-[#635bff]">{kiosk?.venues?.name ?? kiosk?.station_id ?? "Station"}</p>
              <h2 className="mt-1 font-display text-xl font-bold tracking-tight">{r.reference as string}</h2>
              <p className="mt-1 text-sm text-[#b7c8c2]">{kiosk?.venues ? `${kiosk.venues.city}, ${kiosk.venues.state}` : ""}{kiosk?.test_mode ? " · test-mode kiosk" : ""}</p>
            </div>
            <div className="text-right"><Pill tone={overdue ? "red" : (STATE_TONE as Record<string, "cyan" | "gold" | "ink" | "lime" | "mist" | "red">)[r.state as string] ?? "mist"}>{overdue ? "overdue" : (r.state as string).replace(/_/g, " ")}</Pill>
              {(r.return_disputed as boolean) && <div className="mt-2"><Pill tone="gold">return disputed</Pill></div>}
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          {/* Renter */}
          <div className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
            <h3 className="font-display text-lg font-bold">Renter</h3>
            <dl className="mt-3">
              <Row k="Name" v={profile?.full_name ?? "—"} />
              <Row k="Email" v={email ? <Link className="text-forest underline" href={`/admin/customers/${encodeURIComponent(email)}`}>{email}</Link> : "—"} />
              <Row k="Phone" v={phone ?? "—"} />
              <Row k="Account" v={profile ? `${profile.role} — registered` : "Guest checkout"} />
              <Row k="SMS consent" v={(r.sms_consent as boolean) ? "Yes" : "No"} />
              <Row k="Promo" v={(r.promo_code as string) ?? "—"} />
            </dl>
            {email && <Link href={`/admin/customers/${encodeURIComponent(email)}`} className="mt-4 inline-flex min-h-9 items-center rounded-lg bg-[#0a2540] px-4 text-xs font-bold text-white">Open customer 360 →</Link>}
          </div>

          {/* Hardware + charge */}
          <div className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
            <h3 className="font-display text-lg font-bold">Rental</h3>
            <dl className="mt-3">
              <Row k="Banks" v={String(r.bank_count)} />
              <Row k="Bank serial" v={bank?.serial ?? "—"} />
              <Row k="Kiosk" v={<Link className="text-forest underline" href={`/admin/fleet/${kiosk?.station_id ?? ""}`}>{kiosk?.station_id ?? "—"}</Link>} />
              <Row k="Returned to" v={returnKiosk ? (returnKiosk.venues?.name ?? returnKiosk.station_id) : "—"} />
              <Row k="Pricing" v={r.pricing_version as string} />
              <Row k="Due back" v={when(r.non_return_deadline as string)} />
              <Row k="Paused time" v={`${Math.floor(((r.paused_seconds as number) ?? 0) / 60)} min${r.paused_at ? " · paused now" : ""}`} />
              <Row k="Non-return fee" v={(r.non_return_fee_status as string)?.replace(/_/g, " ") ?? "none"} />
            </dl>
          </div>

          {/* Timeline */}
          <div className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
            <h3 className="font-display text-lg font-bold">Timeline</h3>
            <ol className="mt-3 space-y-0.5">
              {timeline.map((t, i) => (
                <li key={i} className="border-b border-[#e3e8ee]/70 py-2 last:border-0">
                  <p className="text-sm font-bold">{t.label}</p>
                  <p className="text-xs text-graphite">{when(t.at)}{t.detail ? ` · ${t.detail}` : ""}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Payments */}
        {payments.map((p) => {
          const card = cards.get(p.id);
          const pRefunds = refunds.filter((x) => x.payment_id === p.id);
          const pDisputes = disputes.filter((x) => x.payment_id === p.id);
          return (
            <section key={p.id} className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between"><h3 className="font-display text-lg font-bold">Payment</h3><Pill tone={p.state === "captured" ? "lime" : p.state === "failed" || p.state === "disputed" ? "red" : "cyan"}>{p.state.replace(/_/g, " ")}</Pill></div>
              <div className="mt-3 grid gap-4 lg:grid-cols-2">
                <dl>
                  <Row k="Card" v={card ? `${card.brand.charAt(0).toUpperCase() + card.brand.slice(1)}${card.funding ? ` ${card.funding}` : ""} •••• ${card.last4}` : p.state === "authorized" || p.state === "failed" ? "Not charged" : "—"} />
                  <Row k="Channel" v={channel(p)} />
                  <Row k="Receipt to" v={p.receipt_email ?? "—"} />
                  <Row k="Authorized" v={fmt(p.amount_authorized_cents ?? 0)} />
                  <Row k="Captured" v={p.amount_captured_cents == null ? "—" : fmt(p.amount_captured_cents)} />
                  <Row k="Refunded" v={(p.amount_refunded_cents ?? 0) > 0 ? fmt(p.amount_refunded_cents!) : "—"} />
                  <Row k="Tax" v={fmt(p.tax_cents ?? 0)} />
                  <Row k="Promo discount" v={(p.discount_cents ?? 0) > 0 ? `−${fmt(p.discount_cents!)}` : "—"} />
                  <Row k="Wallet credit applied" v={(p.credit_cents ?? 0) > 0 ? `−${fmt(p.credit_cents!)}` : fmt(0)} />
                  {p.failure_code && <Row k="Failure" v={p.failure_code.replace(/_/g, " ")} />}
                </dl>
                <dl>
                  <Row k="Authorized at" v={when(p.created_at)} />
                  <Row k="Captured at" v={when(p.captured_at)} />
                  <Row k="Currency" v={(p.currency ?? "usd").toUpperCase()} />
                  <Row k="PaymentIntent" v={p.stripe_payment_intent_id ? <span className="font-mono text-xs">{p.stripe_payment_intent_id.slice(0, 14)}…</span> : "—"} />
                  <Row k="Checkout session" v={p.stripe_checkout_session_id ? <span className="font-mono text-xs">{p.stripe_checkout_session_id.slice(0, 14)}…</span> : "—"} />
                </dl>
              </div>
              {(pRefunds.length > 0 || pDisputes.length > 0) && (
                <ul className="mt-4 space-y-2 border-t border-[#e3e8ee] pt-4 text-sm">
                  {pRefunds.map((x) => <li key={x.id}>Refund {fmt(x.amount_cents)} · {x.reason ?? "—"} · {when(x.created_at)}{x.stripe_refund_id ? ` · ${x.stripe_refund_id.slice(0, 16)}…` : ""}</li>)}
                  {pDisputes.map((x) => <li key={x.id} className="font-bold text-red-800">Dispute {x.amount_cents != null ? fmt(x.amount_cents) : ""} · {x.status ?? "open"}{x.reason ? ` · ${x.reason.replace(/_/g, " ")}` : ""}{x.evidence_due_by ? ` · evidence due ${when(x.evidence_due_by)}` : ""}</li>)}
                </ul>
              )}
            </section>
          );
        })}

        {refundReqs.length > 0 && (
          <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
            <h3 className="font-display text-lg font-bold">Refund requests</h3>
            <ul className="mt-3 space-y-2 text-sm">
              {refundReqs.map((x) => <li key={x.id} className="flex items-center justify-between gap-3 border-b border-[#e3e8ee]/70 py-2 last:border-0"><span>{x.amount_cents != null ? fmt(x.amount_cents) : "—"} · {x.reason.replace(/_/g, " ")}</span><span className="text-xs text-graphite">{x.status} · {when(x.created_at)}</span></li>)}
            </ul>
          </section>
        )}

        {/* Staff actions — same guarded forms as the list view */}
        <section className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
          <h3 className="font-display text-lg font-bold">Actions</h3>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {(r.state === "authorized" || r.state === "dispense_pending") && (
              <form method="post" action={`/api/rentals/${r.id}`}><input type="hidden" name="action" value="dispense" /><input type="hidden" name="back" value={back} /><button className={`${btn} bg-[#635bff] text-white`}>Confirm dispense</button></form>
            )}
            {(r.state === "active" || r.state === "unreturned" || r.state === "overdue" || r.state === "return_pending") && (
              <form method="post" action={`/api/rentals/${r.id}`}><input type="hidden" name="action" value="return" /><input type="hidden" name="back" value={back} /><button className={`${btn} border border-silver/60 hover:border-ink`}>Record return</button></form>
            )}
            {(r.state === "active" || r.state === "return_pending" || r.state === "overdue") && (r.paused_at ? (
              <form method="post" action={`/api/rentals/${r.id}`}><input type="hidden" name="action" value="resume" /><input type="hidden" name="back" value={back} /><button className={`${btn} bg-forest text-white`}>Resume billing</button></form>
            ) : (
              <form method="post" action={`/api/rentals/${r.id}`}><input type="hidden" name="action" value="pause" /><input type="hidden" name="back" value={back} /><button className={`${btn} border border-gold/60 text-gold hover:border-gold`}>Pause billing</button></form>
            ))}
            {["active", "return_pending", "overdue", "unreturned", "dispense_pending"].includes(r.state as string) && (
              <form method="post" action={`/api/rentals/${r.id}`} className="flex items-center gap-1"><input type="hidden" name="action" value="extend" /><input type="hidden" name="back" value={back} />
                <select name="hours" defaultValue="24" aria-label="Extra hours" className={input}>{[4, 12, 24, 48, 72].map((h) => <option key={h} value={h}>+{h}h</option>)}</select>
                <button className={`${btn} border border-silver/60 hover:border-ink`}>Extend deadline</button>
              </form>
            )}
          </div>
          {isAdmin && (overdue || r.state === "unreturned") && payments[0]?.state === "authorized" && (
            <form method="post" action={`/api/rentals/${r.id}`} className="mt-4 max-w-md space-y-2 rounded-xl border border-red-200 p-3">
              <input type="hidden" name="action" value="nonreturn" /><input type="hidden" name="back" value={back} />
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="confirm" value="yes" required /> I confirm this bank was not returned and the non-return maximum should be charged.</label>
              <button className={`${btn} bg-red-700 text-white`}>Charge non-return</button>
            </form>
          )}
          {payments[0]?.state === "captured" && email && (
            <p className="mt-4 text-xs text-graphite">Refunds run through the helpdesk workflow on the <Link className="font-bold underline" href={`/admin/customers/${encodeURIComponent(email)}`}>customer 360</Link> — they need a real ticket and respect the second-admin approval rule.</p>
          )}
        </section>
      </div>
    </AdminGate>
  );
}
