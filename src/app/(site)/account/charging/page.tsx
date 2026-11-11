import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Badge, Notice, PageHero, Section } from "@/components/ui";
import { getSessionUser } from "@/lib/auth";
import { consoleFor } from "@/lib/customer";
import { activeMembership, balance, listGrants, type Grant } from "@/lib/monetization/entitlements";
import { fmt } from "@/lib/pricing";
import { stripeConfigured } from "@/lib/stripe";
import { serviceClient } from "@/lib/supabase";
import { BuyButton, CancelMembershipButton } from "./ChargingActions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Charging benefits", robots: { index: false, follow: false } };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeZone: "America/Chicago" }) : "—");

type Plan = { id: string; name: string; description: string | null; price_cents: number; interval: string; benefit: unknown };
type PackageRow = { id: string; name: string; description: string | null; kind: string; units: number; price_cents: number; validity_days: number | null; sort: number };
type MembershipRow = { id: string; plan_id: string; status: string; current_period_end: string | null; cancel_at_period_end: boolean; created_at: string };
type PurchaseRow = { id: string; package_id: string; status: string; amount_cents: number; created_at: string; paid_at: string | null };

const INTERVAL_LABEL: Record<string, string> = { one_time: "One-time", month: "Monthly", year: "Yearly" };

function benefitText(benefit: unknown): string | null {
  const b = benefit as Record<string, unknown> | null;
  if (!b) return null;
  const parts: string[] = [];
  if (typeof b.rentals === "number" && b.rentals > 0) parts.push(`${b.rentals} free rental${b.rentals === 1 ? "" : "s"}`);
  if (typeof b.rental_minutes === "number" && b.rental_minutes > 0) parts.push(`${b.rental_minutes} prepaid minutes`);
  if (typeof b.credit_cents === "number" && b.credit_cents > 0) parts.push(`${fmt(b.credit_cents)} charging credit`);
  return parts.length ? parts.join(" + ") : null;
}

const unitLabel = (kind: string, units: number) =>
  kind === "rental" ? `${units} free rental${units === 1 ? "" : "s"}`
  : kind === "minute" ? `${units} prepaid minute${units === 1 ? "" : "s"}`
  : `${fmt(units)} credit`;

const STATUS_TONE: Record<string, "lime" | "amber" | "ink"> = {
  active: "lime", trialing: "lime", paid: "lime",
  pending: "amber", past_due: "amber", pending_payment: "amber",
  cancelled: "ink", expired: "ink", refunded: "ink", redeemed: "ink",
};

export default async function ChargingPage({ searchParams }: { searchParams: Promise<{ paid?: string }> }) {
  const sp = await searchParams;
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const console_ = consoleFor(user.role);

  const payments = stripeConfigured();
  const db = serviceClient();

  let plans: Plan[] = [];
  let packages: PackageRow[] = [];
  let grants: Grant[] = [];
  let bal: Partial<Record<"rental" | "minute" | "cent", number>> = {};
  let membership: (MembershipRow & { plan?: { name: string; interval: string; price_cents: number } | null }) | null = null;
  let memberships: (MembershipRow & { plan?: { name: string; interval: string; price_cents: number } | null })[] = [];
  let purchases: (PurchaseRow & { package?: { name: string; kind: string; units: number; validity_days: number | null } | null })[] = [];
  let unavailable = false;

  if (!console_ && db) {
    const [plansRes, pkgsRes, balRes, grantsRes, mem, memsRes, purRes] = await Promise.all([
      db.from("membership_plans").select("id,name,description,price_cents,interval,benefit").eq("active", true).order("price_cents", { ascending: true }),
      db.from("prepaid_packages").select("id,name,description,kind,units,price_cents,validity_days,sort").eq("active", true).order("sort", { ascending: true }).order("price_cents", { ascending: true }),
      balance(db, user.id),
      listGrants(db, user.id),
      activeMembership(db, user.id),
      db.from("customer_memberships").select("id,plan_id,status,current_period_end,cancel_at_period_end,created_at").eq("profile_id", user.id).order("created_at", { ascending: false }).limit(20),
      db.from("package_purchases").select("id,package_id,status,amount_cents,created_at,paid_at").eq("profile_id", user.id).order("created_at", { ascending: false }).limit(50),
    ]);
    plans = (plansRes.data ?? []) as Plan[];
    packages = (pkgsRes.data ?? []) as PackageRow[];
    bal = balRes ?? {};
    grants = grantsRes;
    memberships = (memsRes.data ?? []) as MembershipRow[];
    purchases = (purRes.data ?? []) as PurchaseRow[];
    if (plansRes.error || pkgsRes.error || memsRes.error || purRes.error) unavailable = true;

    // Resolve plan/package display names.
    const planIds = [...new Set([...(mem ? [mem.plan_id] : []), ...memberships.map((m) => m.plan_id)])];
    const pkgIds = [...new Set(purchases.map((p) => p.package_id))];
    const [plansMapRes, pkgsMapRes] = await Promise.all([
      planIds.length ? db.from("membership_plans").select("id,name,interval,price_cents").in("id", planIds) : Promise.resolve({ data: [] }),
      pkgIds.length ? db.from("prepaid_packages").select("id,name,kind,units,validity_days").in("id", pkgIds) : Promise.resolve({ data: [] }),
    ]);
    const planById = new Map(((plansMapRes.data ?? []) as { id: string; name: string; interval: string; price_cents: number }[]).map((p) => [p.id, p]));
    const pkgById = new Map(((pkgsMapRes.data ?? []) as { id: string; name: string; kind: string; units: number; validity_days: number | null }[]).map((p) => [p.id, p]));
    memberships = memberships.map((m) => ({ ...m, plan: planById.get(m.plan_id) ?? null }));
    purchases = purchases.map((p) => ({ ...p, package: pkgById.get(p.package_id) ?? null }));
    membership = mem ? { ...(mem as MembershipRow), plan: planById.get((mem as { plan_id: string }).plan_id) ?? null } : null;
  } else if (!console_) {
    unavailable = true;
  }

  const activeStatuses = new Set(["active", "trialing", "past_due"]);
  const cancellable = membership && activeStatuses.has(membership.status) && !membership.cancel_at_period_end;
  const balanceRows: { label: string; value: string }[] = [
    { label: "Free rentals", value: String(bal.rental ?? 0) },
    { label: "Prepaid minutes", value: String(bal.minute ?? 0) },
    { label: "Charging credit", value: fmt(bal.cent ?? 0) },
  ];

  return (
    <>
      <PageHero eyebrow="Charging benefits" title={<>Memberships &amp; prepaid.</>}>
        <p>Your membership, prepaid balance, and purchase history — all in one place.</p>
      </PageHero>
      <Section className="pt-14">
        <div className="mx-auto max-w-4xl space-y-6">
          {console_ ? (
            <Notice title="This is a staff or partner account.">Customer charging benefits live on customer accounts. <a className="font-bold underline" href={console_.href}>Open the {console_.label}</a>.</Notice>
          ) : (
            <>
              {sp.paid === "1" && <p className="rounded-xl bg-lime px-4 py-3 text-sm font-bold text-ink">Payment received — your benefits update as soon as Stripe confirms (usually a few seconds). Refresh if they don&apos;t appear.</p>}
              {!payments && <Notice title="Payments not available yet.">You can view your benefits and history below, but checkout is turned off until payments are configured.</Notice>}
              {unavailable && <Notice title="Some data isn't available right now.">Please try again later, or contact support.</Notice>}

              {/* Active membership */}
              <div className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="font-display text-lg font-bold">Membership</h2>
                  {membership ? <Badge tone={STATUS_TONE[membership.status] ?? "ink"}>{membership.status.replace(/_/g, " ")}</Badge> : <Badge tone="ink">None</Badge>}
                </div>
                {membership ? (
                  <div className="mt-4 space-y-3">
                    <div>
                      <p className="text-xl font-bold">{membership.plan?.name ?? "Membership"}</p>
                      <p className="text-sm text-graphite">
                        {membership.plan ? `${INTERVAL_LABEL[membership.plan.interval] ?? membership.plan.interval} · ${fmt(membership.plan.price_cents)}` : ""}
                        {membership.current_period_end ? ` · ${membership.cancel_at_period_end ? "ends" : "renews"} ${when(membership.current_period_end)}` : ""}
                      </p>
                      {membership.cancel_at_period_end && <p className="mt-1 text-sm font-semibold text-[#8a4b00]">Cancellation scheduled — benefits continue until the period ends.</p>}
                    </div>
                    {cancellable && payments && <CancelMembershipButton />}
                    {cancellable && !payments && <p className="text-xs text-graphite">Cancellation is unavailable while payments are offline.</p>}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-graphite">No active membership. Pick a plan below to get charging benefits.</p>
                )}
              </div>

              {/* Entitlement balances */}
              <div className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                <h2 className="font-display text-lg font-bold">Your balance</h2>
                <dl className="mt-4 grid gap-4 sm:grid-cols-3">
                  {balanceRows.map((b) => (
                    <div key={b.label} className="rounded-xl bg-mist/50 p-4">
                      <dt className="text-xs font-extrabold uppercase tracking-wider text-graphite">{b.label}</dt>
                      <dd className="mt-1 font-display text-3xl font-bold">{b.value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-3 text-xs text-graphite">Balances count only grants that haven&apos;t expired. Full history below.</p>
              </div>

              {/* Membership plans */}
              <div className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                <h2 className="font-display text-lg font-bold">Membership plans</h2>
                {plans.length === 0 ? (
                  <p className="mt-3 text-sm text-graphite">No membership plans are available right now.</p>
                ) : (
                  <ul className="mt-4 grid gap-4 sm:grid-cols-2">
                    {plans.map((p) => {
                      const benefit = benefitText(p.benefit);
                      return (
                        <li key={p.id} className="flex flex-col rounded-xl border border-mist p-5">
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="font-bold">{p.name}</h3>
                            <span className="shrink-0 text-sm font-extrabold">{fmt(p.price_cents)}<span className="ml-1 text-xs font-semibold text-graphite">/{INTERVAL_LABEL[p.interval]?.toLowerCase() ?? p.interval}</span></span>
                          </div>
                          {p.description && <p className="mt-1 text-sm text-graphite">{p.description}</p>}
                          {benefit && <p className="mt-2 text-sm font-semibold text-forest">Includes {benefit}</p>}
                          <div className="mt-auto pt-4">
                            <BuyButton endpoint="/api/monetization/membership/checkout" body={{ planId: p.id }} label={payments ? "Get this plan" : "Payments offline"} disabled={!payments || p.price_cents <= 0} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {/* Prepaid packages */}
              <div className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                <h2 className="font-display text-lg font-bold">Prepaid packages</h2>
                {packages.length === 0 ? (
                  <p className="mt-3 text-sm text-graphite">No prepaid packages are available right now.</p>
                ) : (
                  <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {packages.map((p) => (
                      <li key={p.id} className="flex flex-col rounded-xl border border-mist p-5">
                        <h3 className="font-bold">{p.name}</h3>
                        {p.description && <p className="mt-1 text-sm text-graphite">{p.description}</p>}
                        <p className="mt-2 text-sm font-semibold text-forest">{unitLabel(p.kind, p.units)}{p.validity_days ? ` · valid ${p.validity_days} days` : " · never expires"}</p>
                        <div className="mt-auto flex items-end justify-between gap-2 pt-4">
                          <span className="font-display text-xl font-bold">{fmt(p.price_cents)}</span>
                          <BuyButton endpoint="/api/monetization/package/checkout" body={{ packageId: p.id }} label={payments ? "Buy" : "Payments offline"} disabled={!payments} />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Grants history */}
              <div className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
                <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Benefit history</h2></div>
                {grants.length === 0 ? (
                  <p className="px-6 py-10 text-sm text-graphite">No benefits yet — they appear here after a membership activates or a package is paid.</p>
                ) : (
                  <table className="w-full min-w-[640px] text-left text-sm">
                    <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite"><tr>{["Benefit", "Unit", "Granted", "Remaining", "Expires", "Status", "Date"].map((h, i) => <th key={i} className="px-4 py-3 font-extrabold">{h}</th>)}</tr></thead>
                    <tbody>
                      {grants.map((g) => (
                        <tr key={g.id} className="border-b border-mist/70 last:border-0">
                          <td className="px-4 py-3 font-bold">{g.kind.replace(/_/g, " ")}</td>
                          <td className="px-4 py-3 text-xs font-semibold">{g.unit}</td>
                          <td className="px-4 py-3">{g.unit === "cent" ? fmt(g.granted) : g.granted}</td>
                          <td className="px-4 py-3 font-bold">{g.unit === "cent" ? fmt(g.remaining) : g.remaining}</td>
                          <td className="px-4 py-3 text-xs text-graphite">{g.expires_at ? when(g.expires_at) : "Never"}</td>
                          <td className="px-4 py-3"><Badge tone={STATUS_TONE[g.status] ?? "ink"}>{g.status}</Badge></td>
                          <td className="px-4 py-3 text-xs text-graphite">{when(g.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Billing history */}
              <div className="grid gap-6 lg:grid-cols-2">
                <div className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
                  <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Membership history</h2></div>
                  {memberships.length === 0 ? (
                    <p className="px-6 py-10 text-sm text-graphite">No memberships yet.</p>
                  ) : (
                    <ul className="divide-y divide-mist">
                      {memberships.map((m) => (
                        <li key={m.id} className="flex items-center justify-between gap-3 px-6 py-3 text-sm">
                          <div>
                            <p className="font-bold">{m.plan?.name ?? "Membership"}</p>
                            <p className="text-xs text-graphite">{when(m.created_at)}{m.current_period_end ? ` · ${m.cancel_at_period_end ? "ends" : "through"} ${when(m.current_period_end)}` : ""}</p>
                          </div>
                          <Badge tone={STATUS_TONE[m.status] ?? "ink"}>{m.status.replace(/_/g, " ")}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
                  <div className="border-b border-mist px-6 py-4"><h2 className="font-display text-lg font-bold">Package purchases</h2></div>
                  {purchases.length === 0 ? (
                    <p className="px-6 py-10 text-sm text-graphite">No package purchases yet.</p>
                  ) : (
                    <ul className="divide-y divide-mist">
                      {purchases.map((p) => (
                        <li key={p.id} className="flex items-center justify-between gap-3 px-6 py-3 text-sm">
                          <div>
                            <p className="font-bold">{p.package?.name ?? "Prepaid package"}</p>
                            <p className="text-xs text-graphite">{when(p.paid_at ?? p.created_at)} · {fmt(p.amount_cents)}</p>
                          </div>
                          <Badge tone={STATUS_TONE[p.status] ?? "ink"}>{p.status}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </Section>
    </>
  );
}
