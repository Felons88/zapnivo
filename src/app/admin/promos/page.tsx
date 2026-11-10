export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { getSessionUser } from "@/lib/auth";
import { fmt } from "@/lib/pricing";
import { type PromoRow, promoUsable } from "@/lib/promos";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Promo codes", robots: { index: false, follow: false } };

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

export default async function Promos({ searchParams }: { searchParams: Promise<{ result?: string; detail?: string }> }) {
  const feedback = await searchParams;
  const db = serviceClient();
  const user = await getSessionUser();
  const isAdmin = user?.role === "admin";
  const { data } = db ? await db.from("promo_codes").select("*").order("created_at", { ascending: false }).limit(200) : { data: null };
  const rows = (data ?? []) as PromoRow[];

  return (
    <AdminGate title="Promo codes" nav="promos">
      {!db ? <EmptyCard title="Promo data not connected">Connect Supabase to manage promo codes.</EmptyCard> : (
        <div className="space-y-6">
          {feedback.result && (
            <div role="status" className={`rounded-xl px-5 py-3 text-sm font-bold ${feedback.result === "error" ? "bg-red-100 text-red-900" : "bg-lime text-ink"}`}>
              {feedback.result === "error" ? feedback.detail ?? "The action failed." : `Promo ${feedback.detail ?? ""} ${feedback.result}.`}
            </div>
          )}
          {isAdmin ? (
            <form method="post" action="/api/admin/promos" className="grid gap-4 rounded-2xl border border-mist bg-white p-6 shadow-sm sm:grid-cols-3">
              <input type="hidden" name="action" value="create" />
              <label className="text-sm font-semibold">Code<input name="code" required minLength={3} maxLength={32} className="mt-1 block w-full rounded-lg border border-silver/60 px-3 py-2" /></label>
              <label className="text-sm font-semibold">Type
                <select name="kind" className="mt-1 block w-full rounded-lg border border-silver/60 px-3 py-2"><option value="percent">Percent off</option><option value="amount">Dollar amount off</option></select>
              </label>
              <label className="text-sm font-semibold">Value (percent, or dollars)<input name="value" type="number" step="0.01" min="0.01" required className="mt-1 block w-full rounded-lg border border-silver/60 px-3 py-2" /></label>
              <label className="text-sm font-semibold">Starts<input name="starts_at" type="date" className="mt-1 block w-full rounded-lg border border-silver/60 px-3 py-2" /></label>
              <label className="text-sm font-semibold">Expires<input name="expires_at" type="date" className="mt-1 block w-full rounded-lg border border-silver/60 px-3 py-2" /></label>
              <label className="text-sm font-semibold">Max redemptions (blank = unlimited)<input name="max_redemptions" type="number" min="1" step="1" className="mt-1 block w-full rounded-lg border border-silver/60 px-3 py-2" /></label>
              <div className="sm:col-span-3"><button className="min-h-10 rounded-full bg-lime px-5 text-sm font-bold text-ink">Create promo code</button></div>
            </form>
          ) : <p className="text-sm text-graphite">Only admins can create or deactivate promo codes.</p>}

          <section aria-label="Promo codes" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            {rows.length === 0 ? <p className="px-6 py-10 text-sm text-graphite">No promo codes yet.</p> : (
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Code", "Discount", "Window", "Redeemed", "Status", ""].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.code} className="border-b border-mist/70 last:border-0">
                      <td className="px-4 py-3 font-bold">{p.code}</td>
                      <td className="px-4 py-3">{p.percent_off !== null ? `${Number(p.percent_off)}% off` : `${fmt(p.amount_off_cents ?? 0)} off`}</td>
                      <td className="px-4 py-3 text-xs text-graphite">{day(p.starts_at)} to {day(p.expires_at)}</td>
                      <td className="px-4 py-3">{p.redemptions}{p.max_redemptions !== null ? ` / ${p.max_redemptions}` : ""}</td>
                      <td className="px-4 py-3"><Pill tone={promoUsable(p) ? "lime" : "mist"}>{!p.active ? "inactive" : promoUsable(p) ? "usable" : "unavailable"}</Pill></td>
                      <td className="px-4 py-3">
                        {isAdmin && (
                          <form method="post" action="/api/admin/promos">
                            <input type="hidden" name="action" value={p.active ? "deactivate" : "activate"} /><input type="hidden" name="code" value={p.code} />
                            <button className="min-h-8 rounded-full border border-silver/60 px-3 text-xs font-bold hover:border-ink">{p.active ? "Deactivate" : "Activate"}</button>
                          </form>
                        )}
                      </td>
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
