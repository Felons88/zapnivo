export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminGate } from "@/components/AdminShell";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Partner operations", robots: { index: false, follow: false } };
const input = "min-h-10 w-full rounded-lg border border-silver/70 px-3 text-sm";

/** Partner back-office: orgs, owner invites, account links, statements and agreement terms. */
export default async function PartnerManage({ searchParams }: { searchParams: Promise<{ result?: string; detail?: string; stm?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isStaff(user)) redirect("/partners");
  const isAdmin = user.role === "admin";
  const feedback = await searchParams;
  const db = serviceClient();
  const [orgsRes, venuesRes] = db ? await Promise.all([
    db.from("organizations").select("id,name").order("created_at", { ascending: false }).limit(100),
    db.from("venues").select("id,name").order("created_at", { ascending: false }).limit(200),
  ]) : [{ data: null }, { data: null }];
  const orgRows = (orgsRes.data ?? []) as { id: string; name: string }[];
  const venueRows = (venuesRes.data ?? []) as { id: string; name: string }[];

  return (
    <AdminGate title="Partner operations" nav="partners">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/admin/partners" className="text-sm font-bold text-graphite hover:text-ink">← Partners</Link>
          <span className="text-xs font-bold uppercase tracking-widest text-graphite">Staff only · partner back-office</span>
        </div>
        {(feedback.result || feedback.stm) && <div role="status" className={`rounded-xl px-5 py-3 text-sm font-bold ${feedback.result === "error" ? "bg-red-100 text-red-900" : "bg-lime text-ink"}`}>
          {feedback.result === "error" ? feedback.detail : feedback.result === "org" ? "Organization created." : feedback.result === "invited" ? "Partner invitation sent and account linked to the organization." : feedback.result === "linked" ? "Existing account linked to the organization." : feedback.result === "venue" ? "Venue owner saved." : feedback.stm === "none" ? "No statements exist for that month." : feedback.stm ? `${feedback.stm} statement email(s) queued.` : "Saved."}
        </div>}

        <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-4">
          <section aria-label="Invite owner" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h2 className="font-display text-lg font-bold">Invite a site owner</h2>
            {isAdmin ? (
              <form method="post" action="/api/admin/partners" className="mt-4 space-y-3">
                <input type="hidden" name="action" value="invite_partner" /><input type="hidden" name="back" value="/admin/partners/manage" />
                <div><label htmlFor="i-email" className="mb-1 block text-xs font-bold">Email</label><input id="i-email" name="email" type="email" required className={input} placeholder="owner@bar.com" /></div>
                <div><label htmlFor="i-name" className="mb-1 block text-xs font-bold">Name</label><input id="i-name" name="name" className={input} placeholder="Alex Rivera" /></div>
                <div><label htmlFor="i-org" className="mb-1 block text-xs font-bold">Organization</label>
                  <select id="i-org" name="organization_id" required className={input}><option value="">Select…</option>{orgRows.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
                <button className="min-h-10 w-full rounded-full bg-ink px-5 text-sm font-bold text-white">Send invite</button>
              </form>
            ) : <p className="mt-3 text-sm text-graphite">Admin-only — org access grants are restricted to admins.</p>}
            <p className="mt-3 text-xs text-graphite">Sends a sign-up email. The owner's portal shows earnings for every venue on that org — one owner, many locations.</p>
          </section>

          <section aria-label="New organization" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h2 className="font-display text-lg font-bold">New organization</h2>
            <form method="post" action="/api/admin/partners" className="mt-4 space-y-3">
              <input type="hidden" name="action" value="create_org" /><input type="hidden" name="back" value="/admin/partners/manage" />
              <div><label htmlFor="o-name" className="mb-1 block text-xs font-bold">Business name</label><input id="o-name" name="name" required className={input} placeholder="Northside Hospitality LLC" /></div>
              <button className="min-h-10 w-full rounded-full bg-ink px-5 text-sm font-bold text-white">Create</button>
            </form>
            <p className="mt-3 text-xs text-graphite">One organization can own several venues. Assign each venue on its detail page.</p>
          </section>

          <section aria-label="Link existing owner" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h2 className="font-display text-lg font-bold">Link existing account</h2>
            {isAdmin ? (
              <form method="post" action="/api/admin/partners" className="mt-4 space-y-3">
                <input type="hidden" name="action" value="link_profile" /><input type="hidden" name="back" value="/admin/partners/manage" />
                <div><label htmlFor="l-email" className="mb-1 block text-xs font-bold">Account email</label><input id="l-email" name="email" type="email" required className={input} /></div>
                <div><label htmlFor="l-org" className="mb-1 block text-xs font-bold">Organization</label><select id="l-org" name="organization_id" required className={input}><option value="">Select…</option>{orgRows.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
                <button className="min-h-10 w-full rounded-full bg-ink px-5 text-sm font-bold text-white">Link account</button>
              </form>
            ) : <p className="mt-3 text-sm text-graphite">Admin-only — org access grants are restricted to admins.</p>}
            <p className="mt-3 text-xs text-graphite">For an account that already exists. Staff accounts cannot be converted.</p>
          </section>

          <section id="statements" aria-label="Monthly statements" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
            <h2 className="font-display text-lg font-bold">Monthly statements</h2>
            <form method="post" action="/api/admin/statements" className="mt-4 space-y-3">
              <div><label htmlFor="s-period" className="mb-1 block text-xs font-bold">Period</label><input id="s-period" name="period" required pattern="\d{4}-(0[1-9]|1[0-2])" className={input} placeholder="2026-05" /></div>
              <button className="min-h-10 w-full rounded-full bg-ink px-5 text-sm font-bold text-white">Queue statement emails</button>
            </form>
            <a href="/admin/payouts" className="mt-3 inline-block text-xs font-extrabold uppercase tracking-wider text-forest hover:underline">Ledgers &amp; payouts →</a>
            <p className="mt-3 text-xs text-graphite">Emails one statement per venue to each owner on the org, through the outbox — nothing claims sent if mail isn't configured.</p>
          </section>
        </div>

        <section aria-label="Agreement terms" className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
          <h2 className="font-display text-lg font-bold">Record agreement terms <span className="ml-2 align-middle text-[10px] font-extrabold uppercase tracking-widest text-silver">admin · private</span></h2>
          {isAdmin ? (
            <form method="post" action="/api/admin/partners" className="mt-4 flex flex-wrap items-end gap-3">
              <input type="hidden" name="action" value="set_agreement" /><input type="hidden" name="back" value="/admin/partners/manage" />
              <div><label htmlFor="a-org" className="mb-1 block text-xs font-bold">Organization</label><select id="a-org" name="organization_id" required className="min-h-10 rounded-lg border border-silver/70 px-3 text-sm"><option value="">Select…</option>{orgRows.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
              <div><label htmlFor="a-venue" className="mb-1 block text-xs font-bold">Venue (blank = all)</label><select id="a-venue" name="venue_id" className="min-h-10 rounded-lg border border-silver/70 px-3 text-sm"><option value="">All venues</option>{venueRows.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
              <div><label htmlFor="a-pct" className="mb-1 block text-xs font-bold">Commission %</label><input id="a-pct" name="commission_pct" type="number" step="0.01" min="0" max="100" required className="min-h-10 w-28 rounded-lg border border-silver/70 px-3 text-sm" /></div>
              <div><label htmlFor="a-date" className="mb-1 block text-xs font-bold">Signed</label><input id="a-date" name="signed_at" type="date" className="min-h-10 rounded-lg border border-silver/70 px-3 text-sm" /></div>
              <button className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white">Save terms</button>
            </form>
          ) : <p className="mt-3 text-sm text-graphite">Admin-only — commission terms are restricted to admins.</p>}
          <p className="mt-3 text-xs text-graphite">Stored in the private agreement record and used only by the ledger job. Never shown publicly; the newest agreement per venue wins.</p>
        </section>
      </div>
    </AdminGate>
  );
}
