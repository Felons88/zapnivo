export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { EQUIPMENT_LABELS, equipmentLabel, isEquipmentCategory } from "@/lib/equipment";
import { PLACEMENT_BOARD_STAGES, STAGE_LABELS, followUpState, loadPlacementBoard, type PlacementCard, type PlacementStage } from "@/lib/placement";
import { serviceClient } from "@/lib/supabase";
import { VENDING_PRODUCT_LABELS, type VendingProductInterest } from "@/lib/validation";

export const metadata: Metadata = { title: "Placements", robots: { index: false, follow: false } };

const STAGE_TONE: Record<PlacementStage, "lime" | "cyan" | "gold" | "mist" | "ink" | "red"> = {
  inquiry: "mist", qualified: "cyan", contacted: "cyan", site_survey: "gold",
  equipment_recommendation: "gold", proposal: "gold", negotiation: "gold",
  agreement_pending: "ink", approved: "lime", sourcing: "lime",
  install_scheduled: "lime", installed: "ink", active: "ink", declined: "red",
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—");

/** product_interest is a free-text list of vending/equipment keys. */
const interestLabels = (s: string | null) =>
  [...new Set((s ?? "").split(/[,;\s]+/).map((t) => t.trim()).filter(Boolean))]
    .map((t) => {
      if (t in VENDING_PRODUCT_LABELS) return VENDING_PRODUCT_LABELS[t as VendingProductInterest];
      if (isEquipmentCategory(t)) return EQUIPMENT_LABELS[t];
      return equipmentLabel(t) ?? t;
    });

const SORTS = ["business", "stage", "assignee", "follow_up", "days", "created"] as const;
type SortKey = (typeof SORTS)[number];
const sortValue = (c: PlacementCard, k: SortKey): string | number => {
  switch (k) {
    case "business": return c.businessName.toLowerCase();
    case "stage": return PLACEMENT_BOARD_STAGES.indexOf(c.stage);
    case "assignee": return (c.assigneeName ?? "￿").toLowerCase();
    case "follow_up": return c.followUpAt ?? "￿";
    case "days": return c.daysInStage;
    case "created": return c.createdAt;
  }
};

type Params = { view?: string; stage?: string; q?: string; sort?: string; dir?: string; result?: string; detail?: string };

function Feedback({ result, detail }: { result?: string; detail?: string }) {
  if (!result && !detail) return null;
  const ok = result !== "error";
  const text = result === "error" ? (detail || "Something went wrong.")
    : result === "moved" ? "Stage updated."
    : result === "note" ? "Activity saved."
    : result === "meta" ? "Placement details saved."
    : result === "assessment" ? "Assessment saved."
    : detail || "Saved.";
  return <div role="status" className={`rounded-xl px-5 py-3 text-sm font-bold ${ok ? "bg-lime text-ink" : "bg-red-100 text-red-900"}`}>{text}</div>;
}

function Card({ c }: { c: PlacementCard }) {
  const fu = followUpState(c.followUpAt, new Date(), c.stage);
  return (
    <Link href={`/admin/placements/${c.id}`} className="block rounded-xl border border-mist bg-white p-3 shadow-sm transition-colors hover:border-forest">
      <div className="flex items-start justify-between gap-2">
        <p className="font-display text-sm font-bold leading-tight">{c.businessName}</p>
        {c.hasAssessment && <span title="Venue assessment on file" className="shrink-0 rounded-full bg-cyan/20 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-forest">assessed</span>}
      </div>
      <p className="mt-0.5 text-xs text-graphite">{c.city}, {c.state} · {c.venueType}</p>
      {c.productInterest && <p className="mt-1 text-[11px] font-bold text-forest">{interestLabels(c.productInterest).join(" · ")}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold text-graphite">
        <span>→ {c.assigneeName ?? "unassigned"}</span>
        <span className={c.daysInStage >= 14 ? "font-extrabold text-red-700" : ""}>{c.daysInStage}d in stage</span>
      </div>
      {c.nextAction && <p className="mt-1 truncate text-[11px] text-ink">Next: {c.nextAction}</p>}
      {fu !== "none" && (
        <p className={`mt-1 text-[11px] font-extrabold ${fu === "overdue" ? "text-red-700" : fu === "today" ? "text-gold" : "text-graphite"}`}>
          Follow-up {fu === "overdue" ? "overdue" : fu === "today" ? "today" : `on ${when(c.followUpAt)}`}
        </p>
      )}
    </Link>
  );
}

export default async function PlacementsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const db = serviceClient();
  if (!db) {
    return <AdminGate title="Placements" nav="placements"><EmptyCard title="Placement data not connected">Connect Supabase to see the placement pipeline.</EmptyCard></AdminGate>;
  }
  const board = await loadPlacementBoard(db);
  const allCards = board.flatMap((col) => col.cards);
  const active = allCards.filter((c) => c.stage !== "declined").length;
  const overdue = allCards.filter((c) => c.followUpOverdue).length;
  const assessed = allCards.filter((c) => c.hasAssessment).length;

  const view = params.view === "table" ? "table" : "board";
  const stageFilter = params.stage && PLACEMENT_BOARD_STAGES.includes(params.stage as PlacementStage) ? (params.stage as PlacementStage) : null;
  const q = (params.q ?? "").trim().toLowerCase();
  const sort: SortKey = (SORTS as readonly string[]).includes(params.sort ?? "") ? (params.sort as SortKey) : "created";
  const dir = params.dir === "asc" ? 1 : -1;

  let rows = allCards;
  if (stageFilter) rows = rows.filter((c) => c.stage === stageFilter);
  if (q) rows = rows.filter((c) => [c.businessName, c.contactName, c.city, c.state, c.venueType, c.assigneeName ?? ""].some((v) => v.toLowerCase().includes(q)));
  if (view === "table") {
    rows = [...rows].sort((a, b) => {
      const va = sortValue(a, sort), vb = sortValue(b, sort);
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return cmp * dir;
    });
  }

  const sortHref = (key: SortKey) => {
    const sp = new URLSearchParams({ view: "table", sort: key, dir: sort === key && dir === -1 ? "asc" : "desc" });
    if (stageFilter) sp.set("stage", stageFilter);
    if (q) sp.set("q", params.q!);
    return `/admin/placements?${sp.toString()}`;
  };
  const viewHref = (v: string) => {
    const sp = new URLSearchParams();
    if (v === "table") { sp.set("view", "table"); if (stageFilter) sp.set("stage", stageFilter); if (q) sp.set("q", params.q!); if (params.sort) sp.set("sort", params.sort); if (params.dir) sp.set("dir", params.dir); }
    return `/admin/placements${sp.size ? `?${sp.toString()}` : ""}`;
  };

  return (
    <AdminGate title="Placements" nav="placements">
      <div className="space-y-6">
        <Feedback result={params.result} detail={params.detail} />
        <section aria-label="Placement summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="In pipeline" value={active} sub={`${allCards.length} total`} />
          <Metric label="Overdue follow-ups" value={overdue} sub={overdue ? "needs attention" : "none"} />
          <Metric label="Assessments" value={assessed} sub="venue assessments on file" />
          <Metric label="Declined" value={allCards.filter((c) => c.stage === "declined").length} sub="can reopen to inquiry" />
        </section>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2" role="tablist" aria-label="View">
            <Link href={viewHref("board")} className={`rounded-full px-4 py-2 text-xs font-extrabold ${view === "board" ? "bg-ink text-white" : "bg-white text-graphite ring-1 ring-mist"}`}>Board</Link>
            <Link href={viewHref("table")} className={`rounded-full px-4 py-2 text-xs font-extrabold ${view === "table" ? "bg-ink text-white" : "bg-white text-graphite ring-1 ring-mist"}`}>Table</Link>
          </div>
          <form method="get" action="/admin/placements" className="flex items-center gap-2">
            {view === "table" && <input type="hidden" name="view" value="table" />}
            <input name="q" defaultValue={params.q ?? ""} placeholder="Search business, city, assignee…" aria-label="Search placements" className="min-h-10 w-64 rounded-lg border border-silver/70 bg-white px-3 text-sm" />
            <button className="min-h-10 rounded-full bg-ink px-4 text-xs font-bold text-white">Search</button>
          </form>
        </div>

        {view === "board" ? (
          <section aria-label="Placement board" className="flex gap-4 overflow-x-auto pb-4">
            {board.map((col) => {
              if (stageFilter && col.stage !== stageFilter) return null;
              return (
                <div key={col.stage} className={`w-72 shrink-0 rounded-2xl border bg-mist/30 ${col.stage === "declined" ? "border-red-200" : "border-mist"}`}>
                  <div className="flex items-center justify-between border-b border-mist/70 px-4 py-3">
                    <h2 className="font-display text-sm font-bold">{col.label}</h2>
                    <Pill tone={STAGE_TONE[col.stage]}>{col.cards.length}</Pill>
                  </div>
                  <div className="space-y-2 p-2">
                    {col.cards.map((c) => <Card key={c.id} c={c} />)}
                    {col.cards.length === 0 && <p className="px-2 py-6 text-center text-xs text-graphite">No applications</p>}
                  </div>
                </div>
              );
            })}
          </section>
        ) : (
          <section aria-label="Placement table" className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
            <div className="flex flex-wrap items-center gap-2 border-b border-mist px-6 py-4">
              <h2 className="font-display text-lg font-bold">All placements</h2>
              <form method="get" action="/admin/placements" className="ml-auto flex items-center gap-2">
                <input type="hidden" name="view" value="table" />
                {q && <input type="hidden" name="q" value={params.q!} />}
                {params.sort && <input type="hidden" name="sort" value={params.sort} />}
                {params.dir && <input type="hidden" name="dir" value={params.dir} />}
                <label className="text-xs font-bold text-graphite">Stage
                  <select name="stage" defaultValue={stageFilter ?? ""} className="ml-2 min-h-9 rounded-lg border border-silver/60 px-2 text-xs font-semibold">
                    <option value="">All stages</option>
                    {PLACEMENT_BOARD_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
                  </select>
                </label>
                <button className="min-h-9 rounded-full bg-mist px-3 text-xs font-bold hover:bg-lime">Filter</button>
              </form>
            </div>
            {rows.length === 0 ? (
              <p className="px-6 py-10 text-sm text-graphite">No placements match.</p>
            ) : (
              <table className="w-full min-w-[1000px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>
                    {([["business", "Business"], ["stage", "Stage"], ["assignee", "Assignee"], ["follow_up", "Follow-up"], ["days", "Days in stage"], ["created", "Applied"]] as [SortKey, string][]).map(([k, label]) => (
                      <th key={k} className="px-4 py-3 font-extrabold">
                        <Link href={sortHref(k)} className="hover:text-ink">{label}{sort === k ? (dir === -1 ? " ↓" : " ↑") : ""}</Link>
                      </th>
                    ))}
                    <th className="px-4 py-3 font-extrabold">Next action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => {
                    const fu = followUpState(c.followUpAt, new Date(), c.stage);
                    return (
                      <tr key={c.id} className="border-b border-mist/70 last:border-0 hover:bg-lime/10">
                        <td className="px-4 py-3">
                          <Link href={`/admin/placements/${c.id}`} className="font-bold text-forest underline underline-offset-2">{c.businessName}</Link>
                          <p className="text-xs text-graphite">{c.city}, {c.state} · {c.venueType}</p>
                        </td>
                        <td className="px-4 py-3"><Pill tone={STAGE_TONE[c.stage]}>{STAGE_LABELS[c.stage]}</Pill></td>
                        <td className="px-4 py-3 text-xs font-semibold">{c.assigneeName ?? "—"}</td>
                        <td className={`px-4 py-3 text-xs font-semibold ${fu === "overdue" ? "text-red-700" : fu === "today" ? "text-gold" : "text-graphite"}`}>{when(c.followUpAt)}{fu === "overdue" ? " · overdue" : ""}</td>
                        <td className="px-4 py-3 text-xs text-graphite">{c.daysInStage}d</td>
                        <td className="px-4 py-3 text-xs text-graphite">{when(c.createdAt)}</td>
                        <td className="max-w-56 truncate px-4 py-3 text-xs text-graphite">{c.nextAction ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        )}
      </div>
    </AdminGate>
  );
}
