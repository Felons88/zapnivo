export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { Badge } from "@/components/ui";
import { fmt } from "@/lib/pricing";
import { paymentReadiness } from "@/lib/payments/readiness";
import { serviceClient } from "@/lib/supabase";
import { ActiveToggle, PackageEditor } from "./MembershipTools";
import { PaymentReadinessCard } from "./PaymentReadinessCard";

export const metadata: Metadata = { title: "Memberships & packages", robots: { index: false, follow: false } };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Chicago" }) : "—");

type Plan = { id: string; name: string; description: string | null; price_cents: number; interval: string; benefit: unknown; active: boolean };
type Pkg = { id: string; name: string; description: string | null; kind: string; units: number; price_cents: number; validity_days: number | null; active: boolean; sort: number };
type Membership = { id: string; profile_id: string; plan_id: string; status: string; current_period_end: string | null; cancel_at_period_end: boolean; stripe_subscription_id: string | null; created_at: string };
type Grant = { id: string; profile_id: string; kind: string; unit: string; granted: number; remaining: number; expires_at: string | null; status: string; source_type: string | null; created_at: string };

const INTERVAL_LABEL: Record<string, string> = { one_time: "One-time", month: "Monthly", year: "Yearly" };

function benefitText(benefit: unknown): string {
  const b = benefit as Record<string, unknown> | null;
  if (!b) return "—";
  const parts: string[] = [];
  if (typeof b.rentals === "number") parts.push(`${b.rentals} rentals`);
  if (typeof b.rental_minutes === "number") parts.push(`${b.rental_minutes} min`);
  if (typeof b.credit_cents === "number") parts.push(fmt(b.credit_cents));
  return parts.join(" + ") || "—";
}

const unitAmt = (g: Grant, v: number) => (g.unit === "cent" ? fmt(v) : String(v));

export default async function MembershipsAdmin({ searchParams }: { searchParams: Promise<{ profile?: string; result?: string }> }) {
  const sp = await searchParams;
  const db = serviceClient();
  const profileFilter = sp.profile?.trim() || null;
  const readiness = await paymentReadiness(db);

  let plans: Plan[] = [], packages: Pkg[] = [], memberships: Membership[] = [], grants: Grant[] = [];
  if (db) {
    const [plansRes, pkgsRes, memsRes, grantsRes] = await Promise.all([
      db.from("membership_plans").select("id,name,description,price_cents,interval,benefit,active").order("price_cents", { ascending: true }),
      db.from("prepaid_packages").select("id,name,description,kind,units,price_cents,validity_days,active,sort").order("sort", { ascending: true }).order("price_cents", { ascending: true }),
      db.from("customer_memberships").select("id,profile_id,plan_id,status,current_period_end,cancel_at_period_end,stripe_subscription_id,created_at").order("created_at", { ascending: false }).limit(100),
      (() => {
        let q = db.from("entitlement_grants").select("id,profile_id,kind,unit,granted,remaining,expires_at,status,source_type,created_at").order("created_at", { ascending: false }).limit(100);
        if (profileFilter) q = q.eq("profile_id", profileFilter);
        return q;
      })(),
    ]);
    plans = (plansRes.data ?? []) as Plan[];
    packages = (pkgsRes.data ?? []) as Pkg[];
    memberships = (memsRes.data ?? []) as Membership[];
    grants = (grantsRes.data ?? []) as Grant[];
  }

  const planName = new Map(plans.map((p) => [p.id, p.name]));

  return (
    <AdminGate title="Memberships & packages" nav="payouts">
      <div className="mb-8"><PaymentReadinessCard readiness={readiness} /></div>
      {!db ? <EmptyCard title="Monetization data not connected">Connect Supabase and apply migrations 0027 + 0031.</EmptyCard> : (
        <div className="space-y-8">
          {sp.result === "saved" && <p className="rounded-xl bg-lime px-4 py-2.5 text-sm font-bold text-ink">Saved.</p>}

          {/* Membership plans */}
          <section className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Membership plans</h2><p className="text-xs text-graphite">Inactive plans never appear in the customer catalog and can't be checked out.</p></div>
            {plans.length === 0 ? <p className="px-6 py-10 text-sm text-graphite">No plans yet. Create them via the advertising console or SQL.</p> : (
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite"><tr>{["Plan", "Interval", "Price", "Benefit", "Status", ""].map((h, i) => <th key={i} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
                <tbody>
                  {plans.map((p) => (
                    <tr key={p.id} className="border-b border-mist/70 last:border-0">
                      <td className="px-4 py-3"><p className="font-bold">{p.name}</p><p className="text-xs text-graphite">{p.id}{p.description ? ` · ${p.description}` : ""}</p></td>
                      <td className="px-4 py-3 text-xs font-semibold">{INTERVAL_LABEL[p.interval] ?? p.interval}</td>
                      <td className="px-4 py-3 font-bold">{fmt(p.price_cents)}</td>
                      <td className="px-4 py-3 text-xs text-graphite">{benefitText(p.benefit)}</td>
                      <td className="px-4 py-3"><Badge tone={p.active ? "lime" : "ink"}>{p.active ? "active" : "inactive"}</Badge></td>
                      <td className="px-4 py-3"><ActiveToggle kind="plans" id={p.id} active={p.active} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* Prepaid packages */}
          <section className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Prepaid packages</h2><p className="text-xs text-graphite">Edit price, units and validity inline; toggle active to control the customer catalog.</p></div>
            {packages.length === 0 ? <p className="px-6 py-10 text-sm text-graphite">No packages yet.</p> : (
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite"><tr>{["Package", "Kind", "Price", "Edit", "Status", ""].map((h, i) => <th key={i} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
                <tbody>
                  {packages.map((p) => (
                    <tr key={p.id} className="border-b border-mist/70 align-top last:border-0">
                      <td className="px-4 py-3"><p className="font-bold">{p.name}</p><p className="text-xs text-graphite">{p.id} · {p.units} {p.kind}{p.validity_days ? ` · ${p.validity_days}d validity` : " · never expires"}{p.description ? ` · ${p.description}` : ""}</p></td>
                      <td className="px-4 py-3 text-xs font-semibold">{p.kind}</td>
                      <td className="px-4 py-3 font-bold">{fmt(p.price_cents)}</td>
                      <td className="px-4 py-3"><PackageEditor id={p.id} priceCents={p.price_cents} units={p.units} validityDays={p.validity_days} /></td>
                      <td className="px-4 py-3"><Badge tone={p.active ? "lime" : "ink"}>{p.active ? "active" : "inactive"}</Badge></td>
                      <td className="px-4 py-3"><ActiveToggle kind="packages" id={p.id} active={p.active} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* Customer memberships */}
          <section className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Customer memberships</h2><p className="text-xs text-graphite">Latest 100. Status is driven by Stripe webhooks for subscriptions.</p></div>
            {memberships.length === 0 ? <p className="px-6 py-10 text-sm text-graphite">No memberships yet.</p> : (
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite"><tr>{["Customer", "Plan", "Status", "Period end", "Cancel at period end", "Stripe sub", "Started"].map((h, i) => <th key={i} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
                <tbody>
                  {memberships.map((m) => (
                    <tr key={m.id} className="border-b border-mist/70 last:border-0">
                      <td className="px-4 py-3 font-mono text-xs">{m.profile_id.slice(0, 8)}…</td>
                      <td className="px-4 py-3 font-bold">{planName.get(m.plan_id) ?? m.plan_id}</td>
                      <td className="px-4 py-3"><Badge tone={m.status === "active" || m.status === "trialing" ? "lime" : m.status === "past_due" ? "amber" : "ink"}>{m.status.replace(/_/g, " ")}</Badge></td>
                      <td className="px-4 py-3 text-xs text-graphite">{when(m.current_period_end)}</td>
                      <td className="px-4 py-3 text-xs">{m.cancel_at_period_end ? "yes" : "—"}</td>
                      <td className="px-4 py-3 font-mono text-xs text-graphite">{m.stripe_subscription_id ? `${m.stripe_subscription_id.slice(0, 12)}…` : "—"}</td>
                      <td className="px-4 py-3 text-xs text-graphite">{when(m.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* Entitlement grants */}
          <section className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="border-b border-mist px-6 py-4">
              <h2 className="font-display text-lg font-bold">Entitlement grants</h2>
              <form method="get" className="mt-3 flex flex-wrap items-end gap-2">
                <label className="text-xs font-bold text-graphite">Filter by profile
                  <input name="profile" defaultValue={profileFilter ?? ""} placeholder="profile uuid" className="ml-1 min-h-9 w-72 rounded-lg border border-silver/70 px-3 font-mono text-xs" />
                </label>
                <button className="min-h-9 rounded-full bg-ink px-4 text-xs font-bold text-white">Filter</button>
              </form>
            </div>
            {grants.length === 0 ? <p className="px-6 py-10 text-sm text-graphite">{profileFilter ? "No grants for that profile." : "No grants yet."}</p> : (
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite"><tr>{["Profile", "Kind", "Unit", "Granted", "Remaining", "Expires", "Status", "Source", "Date"].map((h, i) => <th key={i} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
                <tbody>
                  {grants.map((g) => (
                    <tr key={g.id} className="border-b border-mist/70 last:border-0">
                      <td className="px-4 py-3 font-mono text-xs">{g.profile_id.slice(0, 8)}…</td>
                      <td className="px-4 py-3 font-bold">{g.kind.replace(/_/g, " ")}</td>
                      <td className="px-4 py-3 text-xs font-semibold">{g.unit}</td>
                      <td className="px-4 py-3">{unitAmt(g, g.granted)}</td>
                      <td className="px-4 py-3 font-bold">{unitAmt(g, g.remaining)}</td>
                      <td className="px-4 py-3 text-xs text-graphite">{when(g.expires_at)}</td>
                      <td className="px-4 py-3"><Badge tone={g.status === "active" ? "lime" : "ink"}>{g.status}</Badge></td>
                      <td className="px-4 py-3 text-xs text-graphite">{g.source_type ?? "—"}</td>
                      <td className="px-4 py-3 text-xs text-graphite">{when(g.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </AdminGate>
  );
}
