export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { serviceClient } from "@/lib/supabase";
import {
  EQUIPMENT_LIFECYCLE, EQUIPMENT_MODEL_CATEGORIES, EQUIPMENT_STATUS_LABELS,
  MODEL_CATEGORY_LABELS, MODEL_STATUSES, UNIT_OWNERSHIP, isModelCategory, isEquipmentStatus,
  loadEquipmentBoard, nextStatuses, type EquipmentStatus,
} from "@/lib/vending-equipment";

export const metadata: Metadata = { title: "Equipment", robots: { index: false, follow: false } };

const STATUS_TONE: Record<string, "lime" | "gold" | "red" | "mist" | "ink" | "cyan"> = {
  planned: "mist", sourcing: "mist", ordered: "cyan", received: "cyan", inspected: "cyan",
  available: "lime", assigned: "gold", installed: "gold", active: "lime", maintenance: "gold", retired: "red",
};
const MODEL_TONE: Record<string, "lime" | "gold" | "red" | "mist" | "ink" | "cyan"> = { draft: "mist", active: "lime", discontinued: "red" };
const OWNERSHIP_LABELS: Record<string, string> = { company: "Company", venue: "Venue", leased: "Leased", customer: "Customer" };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
const cents = (c: number | null) => (c == null ? "—" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0 })}`);
const dollars = (c: number | null) => (c == null ? "" : String(c / 100));

export default async function EquipmentPage({ searchParams }: { searchParams: Promise<{ result?: string; detail?: string; category?: string; status?: string }> }) {
  const sp = await searchParams;
  const db = serviceClient();
  const board = db ? await loadEquipmentBoard(db) : null;

  const catFilter = sp.category && isModelCategory(sp.category) ? sp.category : "";
  const statusFilter = sp.status && isEquipmentStatus(sp.status) ? sp.status : "";
  const units = (board?.units ?? []).filter((u) => (!catFilter || u.category === catFilter) && (!statusFilter || u.status === statusFilter));
  const inputCls = "min-h-10 rounded-lg border border-silver/70 px-3 text-sm";
  const selCls = "min-h-10 rounded-lg border border-silver/70 px-2 text-sm font-semibold";
  const pipeline = (board?.counts.byStatus.planned ?? 0) + (board?.counts.byStatus.sourcing ?? 0) + (board?.counts.byStatus.ordered ?? 0);

  return (
    <AdminGate title="Equipment" nav="equipment">
      {!db || !board || board.unavailable ? (
        <EmptyCard title="Equipment data not connected">
          Connect Supabase and apply migration 0071 to manage the vending equipment catalog and unit fleet.
        </EmptyCard>
      ) : (
        <div className="space-y-8">
          {sp.result && (
            <div role="status" className={`rounded-xl px-5 py-3 text-sm font-bold ${sp.result === "error" ? "bg-red-100 text-red-900" : "bg-lime text-ink"}`}>
              {sp.result === "created" ? `Created ${sp.detail ?? "record"}.`
                : sp.result === "updated" ? "Record updated."
                : sp.result === "transitioned" ? `Unit moved to ${sp.detail ?? "new status"}.`
                : sp.detail ?? "The equipment action failed."}
            </div>
          )}

          <section aria-label="Fleet at a glance" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Units" value={board.counts.total} sub={`${Object.keys(board.counts.byCategory).length} categories tracked`} />
            <Metric label="Active" value={board.counts.byStatus.active ?? 0} sub={`${board.counts.byStatus.available ?? 0} available · ${board.counts.byStatus.assigned ?? 0} assigned`} />
            <Metric label="In maintenance" value={board.counts.byStatus.maintenance ?? 0} sub={`${board.counts.byStatus.installed ?? 0} installed, awaiting activation`} />
            <Metric label="Pipeline" value={pipeline} sub={`${board.counts.byStatus.received ?? 0} received · ${board.counts.byStatus.inspected ?? 0} inspected`} />
          </section>

          {/* ─── Models (catalog) ─── */}
          <section aria-label="Equipment models" className="space-y-4">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="font-display text-lg font-bold">Models</h2>
              <p className="text-xs text-graphite">{board.models.length} catalog entr{board.models.length === 1 ? "y" : "ies"} — draft until finalized.</p>
            </div>
            <div className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h3 className="font-display text-base font-bold">Add a model</h3>
              <form method="post" action="/api/admin/equipment" className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <input type="hidden" name="action" value="create_model" />
                <div><label htmlFor="m-cat" className="mb-1 block text-xs font-bold">Category</label>
                  <select id="m-cat" name="category" required className={`${selCls} w-full`}>
                    {EQUIPMENT_MODEL_CATEGORIES.map((c) => <option key={c} value={c}>{MODEL_CATEGORY_LABELS[c]}</option>)}
                  </select></div>
                <div><label htmlFor="m-name" className="mb-1 block text-xs font-bold">Model name</label><input id="m-name" name="model_name" required className={`${inputCls} w-full`} placeholder="VM-400 Combo" /></div>
                <div><label htmlFor="m-mfr" className="mb-1 block text-xs font-bold">Manufacturer</label><input id="m-mfr" name="manufacturer" className={`${inputCls} w-full`} placeholder="Acme Vending" /></div>
                <div><label htmlFor="m-cost" className="mb-1 block text-xs font-bold">Acquisition cost ($)</label><input id="m-cost" name="acquisition_cost_dollars" type="number" min="0" step="0.01" className={`${inputCls} w-full`} placeholder="12500" /></div>
                <div><label htmlFor="m-warranty" className="mb-1 block text-xs font-bold">Warranty (months)</label><input id="m-warranty" name="warranty_months" type="number" min="0" step="1" className={`${inputCls} w-full`} /></div>
                <div><label htmlFor="m-supplier" className="mb-1 block text-xs font-bold">Supplier</label><input id="m-supplier" name="supplier" className={`${inputCls} w-full`} /></div>
                <div className="sm:col-span-2"><label htmlFor="m-conn" className="mb-1 block text-xs font-bold">Connectivity</label><input id="m-conn" name="connectivity" className={`${inputCls} w-full`} placeholder="Cashless, telemetry via cellular" /></div>
                <div className="flex items-end"><button className="min-h-10 w-full rounded-full bg-ink px-5 text-sm font-bold text-white">Add model</button></div>
              </form>
            </div>

            <div className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
              {board.models.length === 0 ? (
                <p className="px-6 py-10 text-sm text-graphite">No models cataloged yet. Add the first equipment model above.</p>
              ) : (
                <table className="w-full min-w-[960px] text-left text-sm">
                  <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                    <tr>{["Category", "Manufacturer / model", "Cost", "Warranty", "Connectivity", "Status", "Edit"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {board.models.map((m) => (
                      <tr key={m.id} className="border-b border-mist/70 align-top last:border-0 hover:bg-lime/10">
                        <td className="px-4 py-3"><Pill tone="mist">{MODEL_CATEGORY_LABELS[m.category as keyof typeof MODEL_CATEGORY_LABELS] ?? m.category}</Pill></td>
                        <td className="px-4 py-3"><span className="font-bold">{m.model_name}</span><span className="block text-xs text-graphite">{m.manufacturer ?? "—"}{m.capacity_description ? ` · ${m.capacity_description}` : ""}</span></td>
                        <td className="px-4 py-3 text-xs font-semibold">{cents(m.acquisition_cost_cents)}{m.supplier ? <span className="block text-graphite">{m.supplier}</span> : null}</td>
                        <td className="px-4 py-3 text-xs font-semibold">{m.warranty_months != null ? `${m.warranty_months} mo` : "—"}</td>
                        <td className="px-4 py-3 text-xs text-graphite">{m.connectivity ?? "—"}</td>
                        <td className="px-4 py-3"><Pill tone={MODEL_TONE[m.status] ?? "mist"}>{m.status}</Pill></td>
                        <td className="px-4 py-3">
                          <details className="group">
                            <summary className="cursor-pointer list-none rounded-full bg-mist px-3 py-1 text-xs font-bold hover:bg-lime [&::-webkit-details-marker]:hidden">Edit</summary>
                            <form method="post" action="/api/admin/equipment" className="mt-2 grid w-72 gap-2 rounded-xl border border-mist bg-mist/30 p-3">
                              <input type="hidden" name="action" value="update_model" /><input type="hidden" name="model_id" value={m.id} />
                              <select name="category" defaultValue={m.category} className={`${selCls} w-full`}>
                                {EQUIPMENT_MODEL_CATEGORIES.map((c) => <option key={c} value={c}>{MODEL_CATEGORY_LABELS[c]}</option>)}
                              </select>
                              <input name="model_name" required defaultValue={m.model_name} className={inputCls} placeholder="Model name" />
                              <input name="manufacturer" defaultValue={m.manufacturer ?? ""} className={inputCls} placeholder="Manufacturer" />
                              <input name="acquisition_cost_dollars" type="number" min="0" step="0.01" defaultValue={dollars(m.acquisition_cost_cents)} className={inputCls} placeholder="Cost ($)" />
                              <input name="warranty_months" type="number" min="0" step="1" defaultValue={m.warranty_months ?? ""} className={inputCls} placeholder="Warranty (months)" />
                              <input name="supplier" defaultValue={m.supplier ?? ""} className={inputCls} placeholder="Supplier" />
                              <input name="connectivity" defaultValue={m.connectivity ?? ""} className={inputCls} placeholder="Connectivity" />
                              <select name="status" defaultValue={m.status} className={`${selCls} w-full`}>
                                {MODEL_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                              </select>
                              <textarea name="notes" defaultValue={m.notes ?? ""} rows={2} className={`${inputCls} w-full`} placeholder="Notes" />
                              <button className="min-h-9 rounded-full bg-ink px-4 text-xs font-bold text-white">Save model</button>
                            </form>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          {/* ─── Units (physical fleet) ─── */}
          <section aria-label="Equipment units" className="space-y-4">
            <h2 className="font-display text-lg font-bold">Units</h2>
            <div className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
              <h3 className="font-display text-base font-bold">Register a unit</h3>
              <form method="post" action="/api/admin/equipment" className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <input type="hidden" name="action" value="create_unit" />
                <div><label htmlFor="u-cat" className="mb-1 block text-xs font-bold">Category</label>
                  <select id="u-cat" name="category" required className={`${selCls} w-full`}>
                    {EQUIPMENT_MODEL_CATEGORIES.map((c) => <option key={c} value={c}>{MODEL_CATEGORY_LABELS[c]}</option>)}
                  </select></div>
                <div><label htmlFor="u-serial" className="mb-1 block text-xs font-bold">Serial number</label><input id="u-serial" name="serial_number" className={`${inputCls} w-full`} placeholder="SN-0001 (optional)" /></div>
                <div><label htmlFor="u-model" className="mb-1 block text-xs font-bold">Model</label>
                  <select id="u-model" name="model_id" className={`${selCls} w-full`}><option value="">— none —</option>
                    {board.models.map((m) => <option key={m.id} value={m.id}>{m.model_name}{m.manufacturer ? ` · ${m.manufacturer}` : ""}</option>)}
                  </select></div>
                <div><label htmlFor="u-venue" className="mb-1 block text-xs font-bold">Venue</label>
                  <select id="u-venue" name="venue_id" className={`${selCls} w-full`}><option value="">— warehouse / unassigned —</option>
                    {board.venues.map((v) => <option key={v.id} value={v.id}>{v.name}{v.city ? ` · ${v.city}` : ""}</option>)}
                  </select></div>
                <div><label htmlFor="u-own" className="mb-1 block text-xs font-bold">Ownership</label>
                  <select id="u-own" name="ownership" className={`${selCls} w-full`}>
                    {UNIT_OWNERSHIP.map((o) => <option key={o} value={o}>{OWNERSHIP_LABELS[o] ?? o}</option>)}
                  </select></div>
                <div><label htmlFor="u-cost" className="mb-1 block text-xs font-bold">Actual cost ($)</label><input id="u-cost" name="cost_dollars" type="number" min="0" step="0.01" className={`${inputCls} w-full`} placeholder="Overrides model estimate" /></div>
                <div><label htmlFor="u-kiosk" className="mb-1 block text-xs font-bold">Kiosk link (charger only)</label>
                  <select id="u-kiosk" name="kiosk_id" className={`${selCls} w-full`}><option value="">— none —</option>
                    {board.kiosks.map((k) => <option key={k.id} value={k.id}>{k.station_id}</option>)}
                  </select></div>
                <div><label htmlFor="u-sched" className="mb-1 block text-xs font-bold">Service schedule</label><input id="u-sched" name="service_schedule" className={`${inputCls} w-full`} placeholder="Quarterly preventive" /></div>
                <div className="sm:col-span-2 lg:col-span-4"><label htmlFor="u-notes" className="mb-1 block text-xs font-bold">Notes</label><input id="u-notes" name="notes" className={`${inputCls} w-full`} /></div>
                <div className="flex items-end"><button className="min-h-10 w-full rounded-full bg-ink px-5 text-sm font-bold text-white">Register unit</button></div>
              </form>
              <p className="mt-3 text-xs text-graphite">New units start at <b>planned</b>. Lifecycle moves are recorded below and appended to the unit&apos;s audit trail. Only charger stations may link a kiosk.</p>
            </div>

            {/* Filters */}
            <form method="get" action="/admin/equipment" className="flex flex-wrap items-end gap-3 rounded-2xl border border-mist bg-white p-4 shadow-sm">
              <div><label htmlFor="f-cat" className="mb-1 block text-xs font-bold">Category</label>
                <select id="f-cat" name="category" defaultValue={catFilter} className={selCls}>
                  <option value="">All categories</option>
                  {EQUIPMENT_MODEL_CATEGORIES.map((c) => <option key={c} value={c}>{MODEL_CATEGORY_LABELS[c]}</option>)}
                </select></div>
              <div><label htmlFor="f-status" className="mb-1 block text-xs font-bold">Status</label>
                <select id="f-status" name="status" defaultValue={statusFilter} className={selCls}>
                  <option value="">All statuses</option>
                  {EQUIPMENT_LIFECYCLE.map((s) => <option key={s} value={s}>{EQUIPMENT_STATUS_LABELS[s]}</option>)}
                </select></div>
              <button className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white">Filter</button>
              {(catFilter || statusFilter) && <a href="/admin/equipment" className="min-h-10 rounded-full bg-mist px-5 py-2.5 text-sm font-bold hover:bg-lime">Clear</a>}
              <p className="ml-auto text-xs text-graphite">{units.length} of {board.units.length} units shown</p>
            </form>

            <div className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
              {units.length === 0 ? (
                <p className="px-6 py-10 text-sm text-graphite">
                  {board.units.length === 0 ? "No units registered yet — the first physical machine appears here once added." : "No units match these filters."}
                </p>
              ) : (
                <table className="w-full min-w-[1100px] text-left text-sm">
                  <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                    <tr>{["Serial / label", "Category", "Model", "Venue", "Kiosk", "Status", "Ownership", "Cost", "Lifecycle"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {units.map((u) => {
                      const next = nextStatuses(u.status);
                      return (
                        <tr key={u.id} className="border-b border-mist/70 align-top last:border-0 hover:bg-lime/10">
                          <td className="px-4 py-3">
                            <span className="font-bold">{u.serial_number ?? u.model_label ?? "—"}</span>
                            {u.serial_number && u.model_label ? <span className="block text-xs text-graphite">{u.model_label}</span> : null}
                            {u.notes ? <span className="block max-w-40 truncate text-xs text-graphite" title={u.notes}>{u.notes}</span> : null}
                          </td>
                          <td className="px-4 py-3 text-xs font-semibold">{MODEL_CATEGORY_LABELS[u.category as keyof typeof MODEL_CATEGORY_LABELS] ?? u.category}</td>
                          <td className="px-4 py-3 text-xs text-graphite">{u.model ? `${u.model.model_name}${u.model.manufacturer ? ` · ${u.model.manufacturer}` : ""}` : "—"}</td>
                          <td className="px-4 py-3">
                            <form method="post" action="/api/admin/equipment" className="flex items-center gap-2">
                              <input type="hidden" name="action" value="assign_venue" /><input type="hidden" name="unit_id" value={u.id} />
                              <select name="venue_id" defaultValue={u.venue_id ?? ""} aria-label={`Assign ${u.serial_number ?? u.id} to venue`} className="min-h-8 rounded-lg border border-silver/60 px-2 text-xs font-semibold">
                                <option value="">— warehouse —</option>
                                {board.venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                              </select>
                              <button className="min-h-8 rounded-full bg-mist px-3 text-xs font-bold hover:bg-lime">Set</button>
                            </form>
                            {u.venue && <p className="mt-0.5 text-xs text-graphite">{u.venue.name}</p>}
                          </td>
                          <td className="px-4 py-3 text-xs font-semibold">
                            {u.category === "charger_station" ? (
                              <form method="post" action="/api/admin/equipment" className="flex items-center gap-2">
                                <input type="hidden" name="action" value="link_kiosk" /><input type="hidden" name="unit_id" value={u.id} />
                                <select name="kiosk_id" defaultValue={u.kiosk_id ?? ""} aria-label="Link kiosk" className="min-h-8 rounded-lg border border-silver/60 px-2 text-xs font-semibold">
                                  <option value="">— none —</option>
                                  {board.kiosks.map((k) => <option key={k.id} value={k.id}>{k.station_id}</option>)}
                                </select>
                                <button className="min-h-8 rounded-full bg-mist px-3 text-xs font-bold hover:bg-lime">Link</button>
                              </form>
                            ) : "—"}
                            {u.kiosk && <p className="mt-0.5 text-xs text-graphite">{u.kiosk.station_id}</p>}
                          </td>
                          <td className="px-4 py-3"><Pill tone={STATUS_TONE[u.status] ?? "mist"}>{EQUIPMENT_STATUS_LABELS[u.status] ?? u.status}</Pill>
                            {u.installed_at && <p className="mt-0.5 text-[11px] text-graphite">installed {when(u.installed_at)}</p>}
                            {u.retired_at && <p className="mt-0.5 text-[11px] text-graphite">retired {when(u.retired_at)}</p>}
                          </td>
                          <td className="px-4 py-3 text-xs font-semibold">{OWNERSHIP_LABELS[u.ownership] ?? u.ownership}</td>
                          <td className="px-4 py-3 text-xs font-semibold">{cents(u.cost_cents)}</td>
                          <td className="px-4 py-3">
                            {next.length === 0 ? (
                              <span className="text-xs text-graphite">Terminal</span>
                            ) : (
                              <form method="post" action="/api/admin/equipment" className="flex flex-wrap items-center gap-2">
                                <input type="hidden" name="action" value="transition" /><input type="hidden" name="unit_id" value={u.id} />
                                <input name="note" placeholder="Note (optional)" className="min-h-8 w-32 rounded-lg border border-silver/60 px-2 text-xs" />
                                <select name="to" required aria-label={`Move ${u.serial_number ?? u.id}`} className="min-h-8 rounded-lg border border-silver/60 px-2 text-xs font-semibold">
                                  {next.map((s) => <option key={s} value={s}>{EQUIPMENT_STATUS_LABELS[s]}</option>)}
                                </select>
                                <button className="min-h-8 rounded-full bg-ink px-3 text-xs font-bold text-white">Move</button>
                              </form>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>
      )}
    </AdminGate>
  );
}
