export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { SystemGate } from "@/components/SystemGate";
import { serviceClient } from "@/lib/supabase";
import { getSessionUser } from "@/lib/auth";
import { roleCan, systemRole } from "@/lib/system/rbac";
import {
  EXCEPTION_KINDS, EXCEPTION_STATES, LEGACY_DISMISSED_STATE,
  listExceptions, type ExceptionListRow,
} from "@/lib/system/exceptions";

export const metadata: Metadata = { title: "Rental Exceptions" };

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + "Z" : "—";

const age = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};

const STATE_TONE: Record<string, string> = {
  new: "bg-sky-400/15 text-sky-300 ring-sky-400/30",
  investigating: "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  awaiting_device: "bg-violet-400/15 text-violet-300 ring-violet-400/30",
  awaiting_support: "bg-orange-500/15 text-orange-300 ring-orange-400/30",
  requires_financial_review: "bg-red-500/15 text-red-300 ring-red-400/30",
  resolved: "bg-lime/15 text-lime ring-lime/30",
  reopened: "bg-orange-500/15 text-orange-300 ring-orange-400/30",
  dismissed: "bg-white/5 text-slate-500 ring-white/10",
};
const stateTone = (s: string | null) => STATE_TONE[s ?? ""] ?? "bg-white/10 text-slate-300 ring-white/15";

const FINANCIAL_KINDS = new Set(["bank_mismatch", "rental_ref_mismatch", "payment_mismatch", "refund_mismatch"]);
const kindTone = (kind: string) =>
  FINANCIAL_KINDS.has(kind)
    ? "bg-red-500/15 text-red-300 ring-red-400/30"
    : "bg-white/10 text-slate-300 ring-white/15";

const STATE_FILTERS = ["active", ...EXCEPTION_STATES, LEGACY_DISMISSED_STATE, "all"] as const;

export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; kind?: string; kiosk?: string; rental?: string; assigned?: string; age?: string }>;
}) {
  const sp = await searchParams;
  const state = STATE_FILTERS.includes(sp.state as (typeof STATE_FILTERS)[number]) ? sp.state! : "active";
  const kind = sp.kind && EXCEPTION_KINDS.includes(sp.kind as (typeof EXCEPTION_KINDS)[number]) ? sp.kind : undefined;
  const kiosk = /^[0-9a-f-]{36}$/i.test(sp.kiosk ?? "") ? sp.kiosk : undefined;
  const rental = /^[0-9a-f-]{36}$/i.test(sp.rental ?? "") ? sp.rental : undefined;
  const assigned = sp.assigned === "me" || sp.assigned === "unassigned" || /^[0-9a-f-]{36}$/i.test(sp.assigned ?? "") ? sp.assigned : undefined;
  const ageHours = sp.age && Number(sp.age) > 0 ? Number(sp.age) : undefined;

  const db = serviceClient();
  const user = await getSessionUser();
  const role = user ? await systemRole(user) : null;
  const canManage = roleCan(role, "system.kiosks.manage");

  const { configured, rows, error } = db
    ? await listExceptions(db, {
        state, kind,
        kioskId: kiosk, rentalId: rental,
        assignedTo: assigned === "me" ? user!.id : assigned,
        olderThanHours: ageHours, limit: 300,
      })
    : { configured: false, rows: [] as ExceptionListRow[], error: undefined };

  const href = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged: Record<string, string | undefined> = { state, kind, kiosk, rental, assigned, age: sp.age, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/system/kiosks/exceptions${s ? `?${s}` : ""}`;
  };

  return (
    <SystemGate perm="system.kiosks.view">
      <div className="space-y-5">
        <div>
          <p className="eyebrow text-lime">Kiosk Infrastructure</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight">Rental exceptions</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Investigation records from <code className="font-mono text-xs">rental_exceptions</code> — raised when a
            kiosk acknowledgement cannot be honestly reconciled (ack/command/rental mismatches). Acks never
            auto-settle; staff resolve them here. <code className="font-mono text-[11px]">requires_financial_review</code>{" "}
            is informational — resolving an exception never moves money (fin_cases owns that).
            Mutations require <code className="font-mono text-[11px]">system.kiosks.manage</code>.
          </p>
        </div>

        {/* State filter */}
        <div className="flex flex-wrap gap-1.5">
          {STATE_FILTERS.map((f) => (
            <Link key={f} href={href({ state: f === "active" ? undefined : f })}
              className={`rounded-full px-3 py-1 font-mono text-[11px] font-bold ring-1 ${
                state === f ? "bg-lime/15 text-lime ring-lime/30" : "bg-white/5 text-slate-400 ring-white/10 hover:bg-white/10"
              }`}>
              {f}
            </Link>
          ))}
        </div>

        {/* Kind + age filters */}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-slate-500">kind:</span>
          <Link href={href({ kind: undefined })} className={`rounded-full px-2.5 py-1 font-mono text-[11px] ring-1 ${!kind ? "bg-lime/15 text-lime ring-lime/30" : "bg-white/5 text-slate-400 ring-white/10 hover:bg-white/10"}`}>all</Link>
          {EXCEPTION_KINDS.map((k) => (
            <Link key={k} href={href({ kind: k })}
              className={`rounded-full px-2.5 py-1 font-mono text-[10px] ring-1 ${kind === k ? "bg-lime/15 text-lime ring-lime/30" : "bg-white/5 text-slate-400 ring-white/10 hover:bg-white/10"}`}>
              {k}
            </Link>
          ))}
          <span className="mx-1 text-slate-600">|</span>
          <span className="text-slate-500">older than:</span>
          {(["", "24", "72", "168"] as const).map((h) => (
            <Link key={h || "any"} href={href({ age: h || undefined })}
              className={`rounded-full px-2.5 py-1 font-mono text-[10px] ring-1 ${(sp.age ?? "") === h ? "bg-lime/15 text-lime ring-lime/30" : "bg-white/5 text-slate-400 ring-white/10 hover:bg-white/10"}`}>
              {h ? `${h}h` : "any"}
            </Link>
          ))}
          {(kiosk || rental || assigned) && (
            <span className="ml-2 font-mono text-[10px] text-slate-500">
              {kiosk && <>kiosk {kiosk.slice(0, 8)}… </>}
              {rental && <>rental {rental.slice(0, 8)}… </>}
              {assigned && <>assigned {assigned === "me" ? "me" : assigned === "unassigned" ? "unassigned" : `${assigned.slice(0, 8)}…`} </>}
              <Link href="/system/kiosks/exceptions" className="text-lime underline">clear</Link>
            </span>
          )}
        </div>

        {!configured && (
          <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
            Backend not configured — exception data unavailable.
          </p>
        )}
        {configured && error && (
          <p className="rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">
            Failed to load exceptions: {error}
          </p>
        )}

        <div className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-white/[0.05] shadow-[0_12px_32px_-16px_rgba(0,0,0,0.8)]">
          <table className="w-full min-w-[1000px] text-left text-xs">
            <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                {["Exception", "Kind", "State", "Kiosk", "Rental", "Assigned", "Age", "Created", "Resolved"].map((h) => (
                  <th key={h} className="px-4 py-3 font-extrabold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-white/5 align-top last:border-0 hover:bg-white/[0.02]">
                  <td className="max-w-[240px] px-4 py-3">
                    <Link href={`/system/kiosks/exceptions/${r.id}`} className="font-bold text-slate-200 hover:text-lime">
                      {r.kind}
                    </Link>
                    <p className="font-mono text-[10px] text-slate-500">{r.id.slice(0, 8)}…{r.reopened_count > 0 ? ` · reopened ×${r.reopened_count}` : ""}</p>
                    {r.detail?.financial_review === true || r.detail?.financial_review_required === true ? (
                      <span className="mt-1 inline-block rounded bg-red-500/15 px-1.5 py-0.5 font-mono text-[9px] font-bold text-red-300 ring-1 ring-red-400/30">
                        financial review{r.detail?.financial_review_required === true ? " owed" : ""}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] font-bold ring-1 ${kindTone(r.kind)}`}>{r.kind}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] font-bold ring-1 ${stateTone(r.state)}`}>{r.state ?? r.status}</span>
                  </td>
                  <td className="px-4 py-3 font-mono text-slate-300">
                    {r.kiosk_id ? <Link className="hover:text-lime" href={`/system/kiosks/exceptions?kiosk=${r.kiosk_id}`}>{r.kiosk_id.slice(0, 8)}…</Link> : "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-slate-300">
                    {r.rental_id ? <Link className="hover:text-lime" href={`/system/kiosks/exceptions?rental=${r.rental_id}`}>{r.rental_id.slice(0, 8)}…</Link> : "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-slate-400">
                    {r.assigned_to ? `${r.assigned_to.slice(0, 8)}…` : <span className="text-slate-600">unassigned</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-slate-400">{age(r.created_at)}</td>
                  <td className="px-4 py-3 font-mono text-slate-400">{when(r.created_at)}</td>
                  <td className="px-4 py-3 font-mono text-slate-400">{when(r.resolved_at)}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-sm text-slate-400">
                    {configured
                      ? `No exceptions match this filter${state === "active" ? " — the active queue is clear" : ""}.`
                      : "No data."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-slate-500">
          API: <code className="font-mono">GET /api/system/exceptions?state=active</code> ·{" "}
          <code className="font-mono">PATCH /api/system/exceptions/{"{id}"}</code>
          {!canManage && " · mutations require system.kiosks.manage"}
        </p>
      </div>
    </SystemGate>
  );
}
