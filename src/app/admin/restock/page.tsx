export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { loadRestockBoard, VISIT_TRANSITIONS, type RestockBoardVisit, type VisitStatus } from "@/lib/inventory";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Restocking", robots: { index: false, follow: false } };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "—");
const input = "min-h-9 w-full rounded-lg border border-silver/70 px-2 text-xs";
const btn = "min-h-9 rounded-full bg-mist px-3 text-xs font-bold hover:bg-lime";
const toneFor = (s: VisitStatus) => (s === "completed" ? "lime" : s === "in_progress" ? "gold" : s === "cancelled" ? "red" : "mist") as "lime" | "gold" | "red" | "mist";
const editable = (s: VisitStatus) => s === "planned" || s === "in_progress";

function VisitCard({ v, skus }: { v: RestockBoardVisit; skus: { id: string; name: string; category: string }[] }) {
  return (
    <article className="rounded-2xl border border-mist bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-display text-base font-bold">{v.unit_label}</p>
          <p className="text-xs text-graphite">
            {v.unit_category?.replace("_", " ") ?? "unit"}{v.venue_name ? ` · ${v.venue_name}` : ""}
            {" · "}tech: {v.technician_label ?? "unassigned"} · scheduled {when(v.scheduled_for)}
          </p>
          {v.notes ? <p className="mt-1 text-xs text-graphite">{v.notes}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          <Pill tone={toneFor(v.status)}>{v.status.replace("_", " ")}</Pill>
          {v.status === "planned" || v.status === "in_progress" ? (
            <div className="flex flex-wrap gap-1">
              {(VISIT_TRANSITIONS[v.status] ?? []).map((to) => (
                <form key={to} method="post" action="/api/admin/restock">
                  <input type="hidden" name="action" value="visit_transition" />
                  <input type="hidden" name="visit_id" value={v.id} />
                  <input type="hidden" name="to" value={to} />
                  <input type="hidden" name="return_to" value="/admin/restock" />
                  <button className={`${btn} ${to === "cancelled" ? "border border-red-300 text-red-700" : ""}`}>
                    {to === "in_progress" ? "Start" : to === "completed" ? "Complete" : "Cancel"}
                  </button>
                </form>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {/* Lines */}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead className="border-b border-mist text-[10px] uppercase tracking-wider text-graphite">
            <tr>{["SKU", "Picked", "Loaded", "Waste", editable(v.status) ? "Update" : ""].map((h) => <th key={h} className="px-2 py-2 font-extrabold">{h}</th>)}</tr>
          </thead>
          <tbody>
            {v.lines.map((l) => (
              <tr key={l.id} className="border-b border-mist/60 last:border-0">
                <td className="px-2 py-2 font-bold">{l.sku_name}<span className="ml-1 font-normal text-graphite">{l.sku_category.replace("_", " ")}</span></td>
                {editable(v.status) ? (
                  <>
                    <td className="px-2 py-2" colSpan={3}>
                      <form method="post" action="/api/admin/restock" className="flex flex-wrap items-center gap-1">
                        <input type="hidden" name="action" value="line_upsert" />
                        <input type="hidden" name="visit_id" value={v.id} />
                        <input type="hidden" name="sku_id" value={l.sku_id} />
                        <input type="hidden" name="return_to" value="/admin/restock" />
                        <input name="qty_picked" type="number" min={0} required defaultValue={l.qty_picked} className="min-h-8 w-16 rounded-lg border border-silver/70 px-1.5" aria-label="qty picked" />
                        <input name="qty_loaded" type="number" min={0} required defaultValue={l.qty_loaded} className="min-h-8 w-16 rounded-lg border border-silver/70 px-1.5" aria-label="qty loaded" />
                        <input name="qty_waste" type="number" min={0} required defaultValue={l.qty_waste} className="min-h-8 w-16 rounded-lg border border-silver/70 px-1.5" aria-label="qty waste" />
                        <button className={btn}>Save</button>
                      </form>
                    </td>
                    <td className="px-2 py-2" />
                  </>
                ) : (
                  <><td className="px-2 py-2">{l.qty_picked}</td><td className="px-2 py-2 font-bold">{l.qty_loaded}</td><td className="px-2 py-2">{l.qty_waste}</td><td /></>
                )}
              </tr>
            ))}
            {v.lines.length === 0 ? <tr><td colSpan={5} className="px-2 py-4 text-graphite">No lines yet.</td></tr> : null}
          </tbody>
        </table>
      </div>

      {editable(v.status) ? (
        <form method="post" action="/api/admin/restock" className="mt-3 flex flex-wrap items-end gap-2 rounded-xl bg-mist/50 p-3">
          <input type="hidden" name="action" value="line_upsert" />
          <input type="hidden" name="visit_id" value={v.id} />
          <input type="hidden" name="return_to" value="/admin/restock" />
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-graphite">SKU
            <select name="sku_id" required className="block min-h-9 rounded-lg border border-silver/70 bg-white px-2 text-xs">
              <option value="">Choose…</option>
              {skus.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.category.replace("_", " ")})</option>)}
            </select></label>
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-graphite">Picked
            <input name="qty_picked" type="number" min={0} defaultValue={0} className="block min-h-9 w-20 rounded-lg border border-silver/70 px-2 text-xs" /></label>
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-graphite">Loaded
            <input name="qty_loaded" type="number" min={0} defaultValue={0} className="block min-h-9 w-20 rounded-lg border border-silver/70 px-2 text-xs" /></label>
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-graphite">Waste
            <input name="qty_waste" type="number" min={0} defaultValue={0} className="block min-h-9 w-20 rounded-lg border border-silver/70 px-2 text-xs" /></label>
          <button className={btn}>Add / update line</button>
        </form>
      ) : null}
    </article>
  );
}

export default async function AdminRestock({ searchParams }: { searchParams: Promise<{ result?: string; detail?: string }> }) {
  const sp = await searchParams;
  const db = serviceClient();
  const board = db ? await loadRestockBoard(db) : null;
  const data = board && !("error" in board) ? board : null;
  const open = data ? data.visits.filter((v) => v.status === "planned" || v.status === "in_progress") : [];
  const closed = data ? data.visits.filter((v) => v.status === "completed" || v.status === "cancelled").slice(0, 50) : [];

  return (
    <AdminGate title="Restocking" nav="restock">
      {!db || !data ? <EmptyCard title="Restock data not connected">{board && "error" in board ? `Could not load restock board (${board.error}).` : "Connect Supabase to manage restock visits."}</EmptyCard> : (
        <div className="space-y-4">
          {sp.result === "error" ? (
            <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-bold text-red-700">{sp.detail ?? "Action failed."}</p>
          ) : sp.result === "saved" ? (
            <p className="rounded-xl bg-lime px-4 py-2.5 text-sm font-bold text-ink">{sp.detail ?? "Saved."}</p>
          ) : null}

          <section className="grid gap-4 sm:grid-cols-3">
            <Metric label="Open visits" value={data.openCount} />
            <Metric label="Planned" value={data.visits.filter((v) => v.status === "planned").length} />
            <Metric label="In progress" value={data.visits.filter((v) => v.status === "in_progress").length} />
          </section>

          <section className="rounded-2xl border border-mist bg-white p-5 shadow-sm">
            <h2 className="font-display text-lg font-bold">Plan a restock visit</h2>
            <p className="mt-1 text-xs text-graphite">Completing a visit decrements warehouse stock by qty picked (clamped at 0) and adds qty loaded to the unit. Waste is recorded for reporting.</p>
            {data.eligibleUnits.length === 0 ? (
              <p className="mt-3 text-sm text-graphite">No non-retired product units yet — create equipment units first.</p>
            ) : (
              <form method="post" action="/api/admin/restock" className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <input type="hidden" name="action" value="visit_create" />
                <input type="hidden" name="return_to" value="/admin/restock" />
                <label className="text-xs font-bold text-graphite">Unit
                  <select name="unit_id" required className="mt-1 block min-h-9 w-full rounded-lg border border-silver/70 bg-white px-2 text-xs">
                    <option value="">Choose…</option>
                    {data.eligibleUnits.map((u) => <option key={u.id} value={u.id}>{u.label} ({u.category.replace("_", " ")})</option>)}
                  </select></label>
                <label className="text-xs font-bold text-graphite">Technician
                  <select name="technician" className="mt-1 block min-h-9 w-full rounded-lg border border-silver/70 bg-white px-2 text-xs">
                    <option value="">Unassigned</option>
                    {data.staff.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select></label>
                <label className="text-xs font-bold text-graphite">Scheduled for
                  <input name="scheduled_for" type="datetime-local" className="mt-1 block min-h-9 w-full rounded-lg border border-silver/70 px-2 text-xs" /></label>
                <label className="text-xs font-bold text-graphite sm:col-span-2 lg:col-span-2">Notes
                  <input name="notes" maxLength={2000} className={input} /></label>
                <div className="flex items-end"><button className={btn}>Create visit</button></div>
              </form>
            )}
          </section>

          <section className="space-y-4">
            <h2 className="font-display text-lg font-bold">Open visits ({open.length})</h2>
            {open.length === 0 ? <p className="rounded-2xl border border-mist bg-white p-4 text-sm text-graphite">Nothing planned or in progress.</p> : open.map((v) => <VisitCard key={v.id} v={v} skus={data.skus} />)}
          </section>

          {closed.length ? (
            <section className="space-y-4">
              <h2 className="font-display text-lg font-bold">Recent closed visits</h2>
              {closed.map((v) => <VisitCard key={v.id} v={v} skus={data.skus} />)}
            </section>
          ) : null}
        </div>
      )}
    </AdminGate>
  );
}
