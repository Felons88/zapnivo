export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { getSessionUser, isStaff } from "@/lib/auth";
import { fmt } from "@/lib/pricing";
import { serviceClient } from "@/lib/supabase";
import { FIN_CASE_STATUSES, FIN_CASE_TYPES, FIN_SEVERITIES, listCases, type FinCaseRow } from "@/lib/finance/investigations";

export const metadata: Metadata = { title: "Financial investigations", robots: { index: false, follow: false } };

const STATUS_TONE: Record<string, "mist" | "lime" | "gold" | "red" | "ink" | "cyan"> = {
  new: "mist", collecting_evidence: "cyan", investigation: "cyan", awaiting_customer: "gold",
  awaiting_hardware: "gold", awaiting_payment: "gold", human_review: "ink", approved_action: "lime",
  denied: "mist", escalated: "red", resolved: "lime", reopened: "gold",
};
const SEV_TONE: Record<string, "mist" | "lime" | "gold" | "red" | "ink" | "cyan"> = {
  low: "mist", normal: "cyan", high: "gold", critical: "red",
};

const label = (s: string) => s.replace(/_/g, " ");

export default async function InvestigationsPage({ searchParams }: { searchParams: Promise<{ status?: string; case_type?: string; severity?: string; q?: string }> }) {
  const sp = await searchParams;
  const me = await getSessionUser();
  const db = serviceClient();
  const status = FIN_CASE_STATUSES.includes(sp.status as never) ? sp.status : undefined;
  const caseType = FIN_CASE_TYPES.includes(sp.case_type as never) ? sp.case_type : undefined;
  const severity = FIN_SEVERITIES.includes(sp.severity as never) ? sp.severity : undefined;
  const q = sp.q?.trim().slice(0, 80) || undefined;

  let cases: FinCaseRow[] = [];
  let loadError: string | null = null;
  if (db && me && isStaff(me)) {
    const res = await listCases(db, { status, caseType, severity, q, limit: 200 });
    if (res.ok) cases = res.data; else loadError = res.error;
  }

  const href = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { status, case_type: caseType, severity, q, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/admin/finance/investigations${s ? `?${s}` : ""}`;
  };

  return (
    <AdminGate title="Financial investigations" nav="investigations">
      {!me || !isStaff(me) ? (
        <EmptyCard title="Staff only">Financial investigations are restricted to staff accounts.</EmptyCard>
      ) : !db ? (
        <EmptyCard title="Not connected">Connect Supabase to use financial investigations.</EmptyCard>
      ) : (
        <div className="space-y-6">
          <p className="max-w-3xl text-sm text-graphite">
            Case-based review of disputed charges, failed dispenses, missing telemetry and credit issues.
            Recommendations are advisory — every refund still goes through the staff refund route after a human decision.
          </p>

          {/* Filters */}
          <form method="get" className="flex flex-wrap items-end gap-3">
            <label className="text-xs font-extrabold uppercase tracking-wider text-graphite">
              Status
              <select name="status" defaultValue={status ?? ""} className="mt-1 block rounded-lg border border-silver/70 bg-white px-3 py-2 text-sm font-bold">
                <option value="">All</option>
                {FIN_CASE_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
              </select>
            </label>
            <label className="text-xs font-extrabold uppercase tracking-wider text-graphite">
              Type
              <select name="case_type" defaultValue={caseType ?? ""} className="mt-1 block rounded-lg border border-silver/70 bg-white px-3 py-2 text-sm font-bold">
                <option value="">All</option>
                {FIN_CASE_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
              </select>
            </label>
            <label className="text-xs font-extrabold uppercase tracking-wider text-graphite">
              Severity
              <select name="severity" defaultValue={severity ?? ""} className="mt-1 block rounded-lg border border-silver/70 bg-white px-3 py-2 text-sm font-bold">
                <option value="">All</option>
                {FIN_SEVERITIES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
              </select>
            </label>
            <label className="text-xs font-extrabold uppercase tracking-wider text-graphite">
              Search
              <input name="q" defaultValue={q ?? ""} placeholder="subject, customer…" className="mt-1 block rounded-lg border border-silver/70 bg-white px-3 py-2 text-sm" />
            </label>
            <button className="min-h-10 rounded-full bg-ink px-5 text-sm font-bold text-white">Filter</button>
            {(status || caseType || severity || q) && <Link href="/admin/finance/investigations" className="py-2 text-xs font-bold text-graphite underline">Clear</Link>}
          </form>

          {loadError ? (
            <EmptyCard title="Couldn't load cases">{loadError}</EmptyCard>
          ) : cases.length === 0 ? (
            <EmptyCard title="No cases">No financial investigation cases match these filters.</EmptyCard>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-mist bg-white shadow-sm">
              <table className="w-full min-w-[960px] text-left text-sm">
                <thead className="border-b border-mist bg-mist/40 text-xs uppercase tracking-wider text-graphite">
                  <tr>{["Subject", "Type", "Status", "Severity", "Claimed", "Proposed refund", "Created"].map((h) => <th key={h} className="px-4 py-3 font-extrabold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {cases.map((c) => {
                    const rec = c.recommendation as { proposed_refund_cents?: number | null } | null;
                    return (
                      <tr key={c.id} className="border-b border-mist/60 last:border-0 hover:bg-mist/30">
                        <td className="px-4 py-3">
                          <Link href={`/admin/finance/investigations/${c.id}`} className="font-bold text-ink hover:underline">{c.subject}</Link>
                          <p className="text-xs text-graphite">{c.customer_ref ?? "no customer ref"}{c.station_id ? ` · station ${c.station_id.slice(0, 8)}` : ""}</p>
                        </td>
                        <td className="px-4 py-3 text-graphite">{label(c.case_type)}</td>
                        <td className="px-4 py-3"><Pill tone={STATUS_TONE[c.status] ?? "mist"}>{label(c.status)}</Pill></td>
                        <td className="px-4 py-3"><Pill tone={SEV_TONE[c.severity] ?? "mist"}>{c.severity}</Pill></td>
                        <td className="px-4 py-3 text-graphite">{c.claimed_amount_cents != null ? fmt(c.claimed_amount_cents) : "—"}</td>
                        <td className="px-4 py-3 font-bold">{rec?.proposed_refund_cents != null ? fmt(rec.proposed_refund_cents) : "—"}</td>
                        <td className="px-4 py-3 text-graphite">{new Date(c.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </AdminGate>
  );
}
