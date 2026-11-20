export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AdminGate } from "@/components/AdminShell";
import { Pill } from "@/components/SupportNav";
import { EQUIPMENT_LABELS, equipmentLabel, equipmentLabelOr, isEquipmentCategory } from "@/lib/equipment";
import { getSessionUser, isStaff } from "@/lib/auth";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Application", robots: { index: false, follow: false } };

const STATUS_TONE = { new: "cyan", reviewed: "mist", consultation: "gold", approved: "lime", declined: "mist", installed: "ink" } as const;
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" });
const interestLabels = (s: string | null) =>
  [...new Set((s ?? "").split(/[,;\s]+/).map((t) => t.trim()).filter(Boolean))]
    .map((t) => (isEquipmentCategory(t) ? EQUIPMENT_LABELS[t] : equipmentLabel(t) ?? t));
const input = "min-h-10 rounded-lg border border-silver/70 px-3 text-sm";

export default async function ApplicationDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ result?: string; detail?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isStaff(user)) redirect("/partners");
  const { id } = await params;
  const feedback = await searchParams;
  const db = serviceClient();
  const [appRes, orgsRes] = db ? await Promise.all([
    db.from("partner_applications").select("*").eq("id", id).maybeSingle(),
    db.from("organizations").select("id,name").order("created_at", { ascending: false }).limit(100),
  ]) : [{ data: null }, { data: null }];
  const a = appRes.data as Record<string, string | null> | null;
  if (!a) notFound();
  const orgRows = (orgsRes.data ?? []) as { id: string; name: string }[];

  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex items-baseline justify-between gap-4 border-b border-[#e3e8ee]/70 py-2 last:border-0"><dt className="text-sm text-graphite">{k}</dt><dd className="text-right text-sm font-bold">{v}</dd></div>
  );

  return (
    <AdminGate title={String(a.business_name)} nav="partners">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/admin/partners" className="text-sm font-bold text-graphite hover:text-ink">← All applications</Link>
          <span className="text-xs font-bold uppercase tracking-widest text-graphite">Staff only · partner pipeline</span>
        </div>
        {(feedback.result || feedback.detail) && <div role="status" className={`rounded-xl px-5 py-3 text-sm font-bold ${feedback.result === "error" ? "bg-red-100 text-red-900" : "bg-[#635bff] text-white"}`}>{feedback.detail ?? "Saved."}</div>}

        <section className="overflow-hidden rounded-2xl bg-[#142126] text-white shadow-sm">
          <div className="border-b border-white/10 px-4 py-2 text-[10px] font-extrabold uppercase tracking-[.18em] text-[#635bff]">Partner application</div>
          <div className="flex flex-wrap items-start justify-between gap-4 p-4 ">
            <div>
              <p className="eyebrow text-[#635bff]">{a.venue_type}</p>
              <h2 className="mt-1 font-display text-xl font-bold tracking-tight">{a.business_name}</h2>
              <p className="mt-1 text-sm text-[#b7c8c2]">{a.contact_name} · {a.email}{a.phone ? ` · ${a.phone}` : ""}</p>
              <p className="mt-1 text-sm text-[#b7c8c2]">{a.city}, {a.state} · applied {when(a.created_at!)}</p>
            </div>
            <Pill tone={(STATUS_TONE as Record<string, "cyan" | "gold" | "ink" | "lime" | "mist" | "red">)[a.status ?? "new"] ?? "mist"}>{a.status}</Pill>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
            <h3 className="font-display text-lg font-bold">What they told us</h3>
            <dl className="mt-3">
              <Row k="Equipment interest" v={interestLabels(a.product_interest).join(" · ") || "—"} />
              <Row k="Space" v={a.space_notes ?? "—"} />
              <Row k="Timeline" v={a.timeline ?? "—"} />
            </dl>
          </div>
          <div className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
            <h3 className="font-display text-lg font-bold">Pipeline actions</h3>
            <form method="post" action="/api/admin/partners" className="mt-3 flex flex-wrap items-center gap-2">
              <input type="hidden" name="action" value="update_application" /><input type="hidden" name="application_id" value={a.id!} /><input type="hidden" name="back" value={`/admin/partners/applications/${a.id}`} />
              <select name="status" defaultValue={a.status ?? "new"} className={input}>{Object.keys(STATUS_TONE).map((s) => <option key={s} value={s}>{s}</option>)}</select>
              <button className="min-h-10 rounded-full bg-[#0a2540] px-4 text-xs font-bold text-white">Save status</button>
            </form>
            {a.status === "approved" && (
              <form method="post" action="/api/admin/partners" className="mt-4 rounded-xl border border-[#635bff] bg-[#edeeff] p-4">
                <p className="text-xs font-extrabold uppercase tracking-wider text-forest">Convert to venue</p>
                <input type="hidden" name="action" value="create_venue_from_application" /><input type="hidden" name="application_id" value={a.id!} /><input type="hidden" name="back" value={`/admin/partners/applications/${a.id}`} />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select name="organization_id" required defaultValue="" className={input}><option value="" disabled>Owner organization…</option>{orgRows.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
                  <button className="min-h-10 rounded-full bg-[#0a2540] px-4 text-xs font-bold text-white">Create venue</button>
                </div>
                <p className="mt-2 text-[11px] text-graphite">Adds an unpublished venue on that org. Register its kiosk on Fleet next.</p>
              </form>
            )}
          </div>
        </section>
      </div>
    </AdminGate>
  );
}
