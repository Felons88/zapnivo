export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { fmt } from "@/lib/pricing";
import { GIFT_PUBLIC_SELECT, type GiftRow, type GiftStatus } from "@/lib/gifts";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Gift credits", robots: { index: false, follow: false } };

const STATUSES: ("" | GiftStatus)[] = ["", "pending_payment", "paid", "redeemed", "expired", "refunded"];
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—");
const tone = (s: GiftStatus) => (s === "paid" || s === "redeemed" ? "lime" : s === "pending_payment" ? "gold" : s === "refunded" ? "red" : "mist");

export default async function AdminGifts({ searchParams }: { searchParams: Promise<{ status?: string; gift?: string; result?: string; detail?: string }> }) {
  const sp = await searchParams;
  const status = STATUSES.includes(sp.status as GiftStatus) ? (sp.status as GiftStatus) : "";
  const db = serviceClient();

  let gifts: GiftRow[] = [];
  let detail: GiftRow | null = null;
  let linkedGrant: { id: string; unit: string; granted: number; remaining: number; status: string; expires_at: string | null } | null = null;
  if (db) {
    let q = db.from("gift_credits").select(GIFT_PUBLIC_SELECT).order("created_at", { ascending: false }).limit(300);
    if (status) q = q.eq("status", status);
    const { data } = await q;
    gifts = (data ?? []) as GiftRow[];

    if (sp.gift && /^[0-9a-f-]{36}$/i.test(sp.gift)) {
      const { data: g } = await db.from("gift_credits").select(GIFT_PUBLIC_SELECT).eq("id", sp.gift).maybeSingle();
      detail = (g as GiftRow | null) ?? null;
      if (detail) {
        const { data: gr } = await db.from("entitlement_grants")
          .select("id,unit,granted,remaining,status,expires_at")
          .eq("source_type", "gift_credit").eq("source_id", detail.id)
          .order("created_at", { ascending: false }).limit(1).maybeSingle();
        linkedGrant = (gr as { id: string; unit: string; granted: number; remaining: number; status: string; expires_at: string | null } | null) ?? null;
      }
    }
  }

  return (
    <AdminGate title="Gift credits" nav="payouts">
      {!db ? <EmptyCard title="Gift data not connected">Connect Supabase to manage gift credits.</EmptyCard> : (
        <div className="space-y-6">
          {sp.result && (
            <div role="status" className={`rounded-xl px-5 py-3 text-sm font-bold ${sp.result === "error" ? "bg-red-100 text-red-900" : "bg-lime text-ink"}`}>
              {sp.result === "error" ? sp.detail ?? "The action failed." : `Gift ${sp.detail ?? ""} ${sp.result}.`}
            </div>
          )}

          <form method="get" className="flex flex-wrap items-end gap-3">
            <label className="text-sm font-semibold">Status
              <select name="status" defaultValue={status} className="mt-1 block rounded-lg border border-silver/60 px-3 py-2">
                {STATUSES.map((s) => <option key={s} value={s}>{s || "All"}</option>)}
              </select>
            </label>
            <button className="min-h-10 rounded-full border border-ink px-5 text-sm font-bold">Filter</button>
          </form>

          {detail && (
            <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-bold">Gift {detail.id.slice(0, 8)}</h2>
                <Pill tone={tone(detail.status)}>{detail.status.replace(/_/g, " ")}</Pill>
              </div>
              <dl className="mt-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <div><dt className="font-bold">Package</dt><dd className="text-graphite">{detail.package} · {detail.value_cents != null ? fmt(detail.value_cents) : "—"} credit</dd></div>
                <div><dt className="font-bold">Purchaser</dt><dd className="text-graphite">{detail.purchaser_email}</dd></div>
                <div><dt className="font-bold">Recipient</dt><dd className="text-graphite">{detail.recipient_email ?? "—"}</dd></div>
                <div><dt className="font-bold">Message</dt><dd className="text-graphite">{detail.message ?? "—"}</dd></div>
                <div><dt className="font-bold">Created</dt><dd className="text-graphite">{when(detail.created_at)}</dd></div>
                <div><dt className="font-bold">Expires</dt><dd className="text-graphite">{when(detail.expires_at)}</dd></div>
                <div><dt className="font-bold">Redeemed</dt><dd className="text-graphite">{detail.redeemed_at ? when(detail.redeemed_at) : "—"}{detail.redeemed_by ? ` · ${detail.redeemed_by.slice(0, 8)}` : ""}</dd></div>
                <div><dt className="font-bold">Refunded</dt><dd className="text-graphite">{detail.refunded_at ? when(detail.refunded_at) : "—"}{detail.refunded_by ? ` · ${detail.refunded_by.slice(0, 8)}` : ""}</dd></div>
                <div><dt className="font-bold">Payment intent</dt><dd className="text-graphite font-mono text-xs">{detail.stripe_payment_intent_id ?? "—"}</dd></div>
                <div><dt className="font-bold">Attempts</dt><dd className="text-graphite">{detail.attempts}</dd></div>
              </dl>
              {linkedGrant && (
                <p className="mt-4 text-sm text-graphite">
                  Linked grant: {linkedGrant.unit} · {linkedGrant.remaining}/{linkedGrant.granted} remaining · {linkedGrant.status}
                </p>
              )}
              {["paid", "redeemed"].includes(detail.status) && (
                <form method="post" action={`/api/admin/gifts/${detail.id}/refund`} className="mt-5">
                  <button className="min-h-10 rounded-full bg-red-700 px-5 text-sm font-bold text-white">Refund this gift</button>
                  <p className="mt-2 text-xs text-graphite">Marks the gift refunded and revokes any unused credit grant.</p>
                </form>
              )}
            </section>
          )}

          <section aria-label="Gift credits" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            {gifts.length === 0 ? <p className="px-6 py-10 text-sm text-graphite">No gift credits{status ? ` with status “${status.replace(/_/g, " ")}”` : ""} yet.</p> : (
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Package", "Value", "Purchaser", "Recipient", "Status", "Created", "Redeemed", ""].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {gifts.map((g) => (
                    <tr key={g.id} className="border-b border-mist/70 last:border-0">
                      <td className="px-4 py-3 font-bold">{g.package}</td>
                      <td className="px-4 py-3">{g.value_cents != null ? fmt(g.value_cents) : "—"}</td>
                      <td className="px-4 py-3 text-graphite">{g.purchaser_email}</td>
                      <td className="px-4 py-3 text-graphite">{g.recipient_email ?? "—"}</td>
                      <td className="px-4 py-3"><Pill tone={tone(g.status)}>{g.status.replace(/_/g, " ")}</Pill></td>
                      <td className="px-4 py-3 text-xs text-graphite">{when(g.created_at)}</td>
                      <td className="px-4 py-3 text-xs text-graphite">{g.redeemed_at ? when(g.redeemed_at) : "—"}</td>
                      <td className="px-4 py-3"><a className="font-bold underline underline-offset-4" href={`/admin/gifts?gift=${g.id}${status ? `&status=${status}` : ""}`}>View</a></td>
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
