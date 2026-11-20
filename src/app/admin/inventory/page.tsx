export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { loadInventoryBoard, SKU_CATEGORIES, type StockLocationView } from "@/lib/inventory";
import { serviceClient } from "@/lib/supabase";

export const metadata: Metadata = { title: "Inventory", robots: { index: false, follow: false } };

const fmt$ = (cents: number | null) => (cents == null ? "—" : `$${(cents / 100).toFixed(2)}`);
const input = "min-h-9 w-full rounded-lg border border-silver/70 px-2 text-xs";
const btn = "min-h-9 rounded-full bg-[#eef1f5] px-3 text-xs font-bold hover:bg-[#edeeff]";
const CATEGORIES = [...SKU_CATEGORIES];

function SkuForm({ sku }: { sku?: { id: string; category: string; name: string; supplier: string | null; unit_cost_cents: number | null; reorder_point: number; track_expiry: boolean; active: boolean; notes: string | null } }) {
  return (
    <form method="post" action="/api/admin/inventory" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <input type="hidden" name="action" value={sku ? "sku_update" : "sku_create"} />
      <input type="hidden" name="return_to" value="/admin/inventory" />
      {sku ? <input type="hidden" name="sku_id" value={sku.id} /> : null}
      {sku ? <input type="hidden" name="active" value={sku.active ? "1" : "0"} /> : null}
      <label className="text-xs font-bold text-graphite">Name
        <input name="name" required maxLength={160} defaultValue={sku?.name} className={input} /></label>
      <label className="text-xs font-bold text-graphite">Category
        <select name="category" defaultValue={sku?.category ?? "snack"} className={input}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
        </select></label>
      <label className="text-xs font-bold text-graphite">Supplier
        <input name="supplier" maxLength={160} defaultValue={sku?.supplier ?? ""} className={input} /></label>
      <label className="text-xs font-bold text-graphite">Unit cost (cents)
        <input name="unit_cost_cents" type="number" min={0} defaultValue={sku?.unit_cost_cents ?? ""} className={input} /></label>
      <label className="text-xs font-bold text-graphite">Reorder point
        <input name="reorder_point" type="number" min={0} defaultValue={sku?.reorder_point ?? 0} className={input} /></label>
      <label className="flex items-end gap-2 pb-1 text-xs font-bold text-graphite">
        <input type="checkbox" name="track_expiry" value="1" defaultChecked={sku?.track_expiry} className="h-4 w-4" /> Track expiry</label>
      <label className="text-xs font-bold text-graphite sm:col-span-2 lg:col-span-3">Notes
        <input name="notes" maxLength={2000} defaultValue={sku?.notes ?? ""} className={input} /></label>
      <div className="flex items-end"><button className={btn}>{sku ? "Save SKU" : "Add SKU"}</button></div>
    </form>
  );
}

function StockForms({ skuId, loc }: { skuId: string; loc: StockLocationView }) {
  const hidden = (
    <>
      <input type="hidden" name="sku_id" value={skuId} />
      <input type="hidden" name="unit_id" value={loc.unit_id ?? ""} />
      <input type="hidden" name="venue_id" value={loc.venue_id ?? ""} />
      <input type="hidden" name="return_to" value="/admin/inventory" />
    </>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <form method="post" action="/api/admin/inventory" className="flex items-center gap-1">
        {hidden}
        <input type="hidden" name="action" value="stock_adjust" />
        <input name="delta" required type="number" placeholder="±qty" className="min-h-8 w-20 rounded-lg border border-silver/70 px-2 text-xs" />
        <input name="reason" maxLength={200} placeholder="reason" className="hidden min-h-8 w-28 rounded-lg border border-silver/70 px-2 text-xs sm:block" />
        <button className={btn}>Adjust</button>
      </form>
      <form method="post" action="/api/admin/inventory" className="flex items-center gap-1">
        {hidden}
        <input type="hidden" name="action" value="stock_set" />
        <input name="qty" required type="number" min={0} placeholder="set" className="min-h-8 w-20 rounded-lg border border-silver/70 px-2 text-xs" />
        <button className={btn}>Set count</button>
      </form>
    </div>
  );
}

function LocationLines({ skuId, locations }: { skuId: string; locations: StockLocationView[] }) {
  return (
    <ul className="space-y-1.5">
      {locations.map((l) => (
        <li key={l.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-[#eef1f5]/50 px-3 py-2 text-xs">
          <span className="font-bold">{l.label}</span>
          <span className="text-graphite">{l.kind}</span>
          <span className={`font-extrabold ${l.low ? "text-red-600" : ""}`}>{l.qty} on hand{l.low ? " · low" : ""}</span>
          <StockForms skuId={skuId} loc={l} />
        </li>
      ))}
    </ul>
  );
}

export default async function AdminInventory({ searchParams }: { searchParams: Promise<{ result?: string; detail?: string; edit?: string }> }) {
  const sp = await searchParams;
  const db = serviceClient();
  const board = db ? await loadInventoryBoard(db) : null;
  const data = board && !("error" in board) ? board : null;
  const editing = sp.edit && data ? data.skus.find((s) => s.id === sp.edit) : null;

  return (
    <AdminGate title="Inventory" nav="inventory">
      {!db || !data ? <EmptyCard title="Inventory data not connected">{board && "error" in board ? `Could not load inventory (${board.error}).` : "Connect Supabase to manage SKUs and stock."}</EmptyCard> : (
        <div className="space-y-4">
          {sp.result === "error" ? (
            <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-bold text-red-700">{sp.detail ?? "Action failed."}</p>
          ) : sp.result === "saved" ? (
            <p className="rounded-xl bg-[#635bff] px-4 py-2.5 text-sm font-bold text-white">{sp.detail ?? "Saved."}</p>
          ) : null}

          <section className="grid gap-4 sm:grid-cols-3">
            <Metric label="SKUs" value={data.skus.length} />
            <Metric label="Low stock" value={data.lowStockCount} />
            <Metric label="Restockable units" value={data.units.length} />
          </section>

          <section className="rounded-2xl border border-[#e3e8ee] bg-white p-5 shadow-sm">
            <h2 className="font-display text-lg font-bold">{editing ? `Edit SKU — ${editing.name}` : "New SKU"}</h2>
            <div className="mt-3"><SkuForm sku={editing ?? undefined} /></div>
            {editing ? <p className="mt-2 text-xs"><Link href="/admin/inventory" className="font-bold text-forest underline">Cancel edit</Link></p> : null}
          </section>

          {/* Desktop table */}
          <section className="hidden overflow-x-auto rounded-2xl border border-[#e3e8ee] bg-white shadow-sm md:block">
            <table className="w-full min-w-[1100px] text-left text-sm">
              <thead className="border-b border-[#e3e8ee] bg-[#eef1f5]/40 text-xs uppercase tracking-wider text-graphite">
                <tr>{["SKU", "Cost", "Reorder", "Expiry", "Warehouse", "Units", "Venues", "Total", "Status", ""].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {data.skus.map((s) => (
                  <tr key={s.id} className="border-b border-[#e3e8ee]/70 align-top last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-bold">{s.name}</div>
                      <div className="text-xs text-graphite">{s.category.replace("_", " ")}{s.supplier ? ` · ${s.supplier}` : ""}</div>
                    </td>
                    <td className="px-4 py-3 text-xs">{fmt$(s.unit_cost_cents)}</td>
                    <td className="px-4 py-3 text-xs">{s.reorder_point}</td>
                    <td className="px-4 py-3 text-xs">{s.track_expiry ? "yes" : "—"}</td>
                    <td className="px-4 py-3 text-xs font-bold">{s.warehouse}{s.lowStock ? <span className="ml-1 text-red-600">low</span> : null}</td>
                    <td className="px-4 py-3 text-xs">{s.locations.filter((l) => l.kind === "unit").reduce((a, l) => a + l.qty, 0)}</td>
                    <td className="px-4 py-3 text-xs">{s.locations.filter((l) => l.kind === "venue").reduce((a, l) => a + l.qty, 0)}</td>
                    <td className="px-4 py-3 text-xs font-bold">{s.total}</td>
                    <td className="px-4 py-3">
                      <form method="post" action="/api/admin/inventory">
                        <input type="hidden" name="action" value="sku_update" />
                        <input type="hidden" name="sku_id" value={s.id} />
                        <input type="hidden" name="active" value={s.active ? "0" : "1"} />
                        <input type="hidden" name="return_to" value="/admin/inventory" />
                        <button className={s.active ? "min-h-8 rounded-full bg-[#635bff] text-white px-3 text-xs font-bold" : "min-h-8 rounded-full bg-[#eef1f5] px-3 text-xs font-bold"}>
                          {s.active ? "active" : "inactive"}
                        </button>
                      </form>
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/inventory?edit=${s.id}`} className={btn}>Edit</Link>
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-bold text-forest">Stock locations</summary>
                        <div className="mt-2 min-w-72"><LocationLines skuId={s.id} locations={s.locations} /></div>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.skus.length === 0 ? <p className="px-4 py-8 text-sm text-graphite">No SKUs yet — add the first one above.</p> : null}
          </section>

          {/* Mobile cards */}
          <section className="space-y-3 md:hidden">
            {data.skus.map((s) => (
              <article key={s.id} className="rounded-2xl border border-[#e3e8ee] bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-bold">{s.name}</p>
                    <p className="text-xs text-graphite">{s.category.replace("_", " ")}{s.supplier ? ` · ${s.supplier}` : ""} · {fmt$(s.unit_cost_cents)}</p>
                  </div>
                  {s.lowStock ? <Pill tone="gold">low stock</Pill> : <Pill tone="lime">{s.active ? "active" : "inactive"}</Pill>}
                </div>
                <p className="mt-2 text-xs text-graphite">Warehouse {s.warehouse} · units {s.locations.filter((l) => l.kind === "unit").reduce((a, l) => a + l.qty, 0)} · venues {s.locations.filter((l) => l.kind === "venue").reduce((a, l) => a + l.qty, 0)} · total {s.total}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link href={`/admin/inventory?edit=${s.id}`} className={btn}>Edit</Link>
                  <form method="post" action="/api/admin/inventory">
                    <input type="hidden" name="action" value="sku_update" />
                    <input type="hidden" name="sku_id" value={s.id} />
                    <input type="hidden" name="active" value={s.active ? "0" : "1"} />
                    <input type="hidden" name="return_to" value="/admin/inventory" />
                    <button className={btn}>{s.active ? "Deactivate" : "Activate"}</button>
                  </form>
                </div>
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs font-bold text-forest">Stock locations & adjustments</summary>
                  <div className="mt-2"><LocationLines skuId={s.id} locations={s.locations} /></div>
                </details>
              </article>
            ))}
            {data.skus.length === 0 ? <p className="rounded-2xl border border-[#e3e8ee] bg-white p-4 text-sm text-graphite">No SKUs yet — add the first one above.</p> : null}
          </section>
        </div>
      )}
    </AdminGate>
  );
}
