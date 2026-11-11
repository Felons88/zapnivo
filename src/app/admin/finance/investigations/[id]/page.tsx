export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminGate } from "@/components/AdminShell";
import { EmptyCard, Metric } from "@/components/PortalShell";
import { Pill } from "@/components/SupportNav";
import { getSessionUser, isStaff } from "@/lib/auth";
import { fmt } from "@/lib/pricing";
import { serviceClient } from "@/lib/supabase";
import { caseRiskSignals, getCase, type EvidenceDossier, type EvidenceFact, type FinCaseRow, type MissingRecord, type Recommendation } from "@/lib/finance/investigations";
import { CaseActions } from "./CaseActions";

export const metadata: Metadata = { title: "Investigation case", robots: { index: false, follow: false } };

const label = (s: string) => s.replace(/_/g, " ");
const TONE: Record<string, "mist" | "lime" | "gold" | "red" | "ink" | "cyan"> = {
  mist: "mist", lime: "lime", gold: "gold", red: "red", ink: "ink", cyan: "cyan",
};

function FactList({ facts, empty }: { facts: EvidenceFact[]; empty: string }) {
  if (facts.length === 0) return <p className="text-sm text-graphite">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {facts.map((f, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${f.tone === "bad" ? "bg-red-600" : f.tone === "warn" ? "bg-gold" : "bg-forest"}`} aria-hidden />
          <span>{f.summary} <code className="text-[10px] text-graphite/70">{f.ref}</code></span>
        </li>
      ))}
    </ul>
  );
}

function MissingList({ items }: { items: MissingRecord[] }) {
  if (items.length === 0) return <p className="text-sm text-graphite">Nothing missing.</p>;
  return (
    <ul className="space-y-1.5">
      {items.map((m, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-silver" aria-hidden />
          <span>{m.description}{m.ref ? <> <code className="text-[10px] text-graphite/70">{m.ref}</code></> : null}</span>
        </li>
      ))}
    </ul>
  );
}

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getSessionUser();
  const db = serviceClient();
  if (!db || !me || !isStaff(me)) {
    return (
      <AdminGate title="Investigation case" nav="investigations">
        <EmptyCard title="Unavailable">This case can't be shown.</EmptyCard>
      </AdminGate>
    );
  }
  const res = await getCase(db, id);
  if (!res.ok) notFound();
  const { case: c, events } = res.data;
  const dossier = (c.evidence && Object.keys(c.evidence as object).length ? c.evidence : null) as EvidenceDossier | null;
  const rec = c.recommendation as Recommendation | null;
  let signals: Awaited<ReturnType<typeof caseRiskSignals>> = [];
  try { signals = await caseRiskSignals(db, c); } catch { signals = []; }

  return (
    <AdminGate title={c.subject} nav="investigations">
      <div className="space-y-6">
        <p className="text-sm"><Link href="/admin/finance/investigations" className="font-bold text-forest underline">← All investigations</Link></p>

        {/* Header */}
        <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={TONE[c.status] ?? "mist"}>{label(c.status)}</Pill>
            <Pill tone={TONE[c.severity] ?? "mist"}>{c.severity} severity</Pill>
            <Pill tone="ink">{label(c.case_type)}</Pill>
            {c.decision && <Pill tone={c.decision === "approved" ? "lime" : "mist"}>decision: {c.decision}</Pill>}
          </div>
          <h2 className="mt-3 font-display text-2xl font-bold">{c.subject}</h2>
          {c.description && <p className="mt-2 max-w-3xl whitespace-pre-wrap text-sm text-graphite">{c.description}</p>}
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="eyebrow text-[10px] text-graphite">Customer</dt><dd className="font-bold">{c.customer_ref ?? "—"}</dd></div>
            <div><dt className="eyebrow text-[10px] text-graphite">Claimed</dt><dd className="font-bold">{c.claimed_amount_cents != null ? fmt(c.claimed_amount_cents) : "—"}</dd></div>
            <div><dt className="eyebrow text-[10px] text-graphite">Rental</dt><dd className="font-bold">{c.rental_id ? <code className="text-xs">{c.rental_id.slice(0, 8)}…</code> : "—"}</dd></div>
            <div><dt className="eyebrow text-[10px] text-graphite">Station</dt><dd className="font-bold">{c.station_id ?? "—"}</dd></div>
          </dl>
          {c.decision_rationale && (
            <p className="mt-4 rounded-lg bg-mist/50 p-3 text-sm"><b>Decision rationale:</b> {c.decision_rationale}</p>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Actions */}
          <div className="lg:col-span-1">
            <CaseActions caseId={c.id} status={c.status} decision={c.decision} paymentId={c.payment_id} canDecide={me.role === "admin" || me.role === "staff"} />
          </div>

          {/* Evidence dossier */}
          <div className="space-y-6 lg:col-span-2">
            {!dossier ? (
              <EmptyCard title="No evidence yet">Run “Re-collect evidence” to build the dossier from live records.</EmptyCard>
            ) : (
              <>
                <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                  <h3 className="font-display text-lg font-bold">Verified facts</h3>
                  <p className="mb-3 text-xs text-graphite">Pulled from system records — each cites its source row.</p>
                  <FactList facts={dossier.verified_facts} empty="No verified facts collected." />
                </section>

                <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                  <h3 className="font-display text-lg font-bold">Customer statements</h3>
                  <p className="mb-3 text-xs text-graphite">What the customer said — unverified claims, kept separate from facts.</p>
                  <FactList facts={dossier.customer_statements} empty="No customer statements on file." />
                </section>

                <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                  <h3 className="font-display text-lg font-bold">System observations</h3>
                  <FactList facts={dossier.system_observations} empty="No observations." />
                </section>

                <div className="grid gap-6 md:grid-cols-2">
                  <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                    <h3 className="font-display text-lg font-bold">Missing records</h3>
                    <p className="mb-3 text-xs text-graphite">Gaps in the data — never counted against the customer.</p>
                    <MissingList items={dossier.missing_records} />
                  </section>
                  <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                    <h3 className="font-display text-lg font-bold">Conflicts</h3>
                    <FactList facts={dossier.conflicts} empty="No conflicts detected." />
                  </section>
                </div>

                <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                  <h3 className="font-display text-lg font-bold">Policy notes</h3>
                  <ul className="list-disc space-y-1 pl-5 text-sm text-graphite">
                    {dossier.policy_notes.map((p, i) => <li key={i}>{p}</li>)}
                  </ul>
                  <p className="mt-3 text-xs text-graphite">Dossier collected {new Date(dossier.collected_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</p>
                </section>
              </>
            )}

            {/* Recommendation */}
            {rec && (
              <section className="rounded-2xl border-2 border-forest/40 bg-white p-6 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-display text-lg font-bold">Recommendation</h3>
                  <div className="flex gap-1.5">
                    <Pill tone={rec.confidence === "high" ? "lime" : rec.confidence === "medium" ? "gold" : "mist"}>{rec.confidence} confidence</Pill>
                    {rec.proposed_refund_cents != null && <Pill tone="ink">proposes {fmt(rec.proposed_refund_cents)}</Pill>}
                  </div>
                </div>
                <p className="mt-1 text-xs text-graphite">Advisory only — generated {new Date(rec.generated_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}. Requires human decision.</p>
                {rec.reasoning.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-extrabold uppercase tracking-wider text-graphite">Reasoning</p>
                    <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{rec.reasoning.map((r, i) => <li key={i}>{r}</li>)}</ul>
                  </div>
                )}
                {rec.contradicting.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-extrabold uppercase tracking-wider text-red-700">Contradicting evidence</p>
                    <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-graphite">{rec.contradicting.map((r, i) => <li key={i}>{r}</li>)}</ul>
                  </div>
                )}
                {rec.missing.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-extrabold uppercase tracking-wider text-graphite">Still missing</p>
                    <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-graphite">{rec.missing.map((r, i) => <li key={i}>{r}</li>)}</ul>
                  </div>
                )}
                {rec.credit_restore && (
                  <p className="mt-3 rounded-lg bg-gold/30 p-3 text-sm"><b>Credit restoration suggested:</b> {rec.credit_restore.note}</p>
                )}
                <div className="mt-4 rounded-xl bg-mist/50 p-4">
                  <p className="text-xs font-extrabold uppercase tracking-wider text-graphite">Draft customer explanation</p>
                  <p className="mt-1 text-sm italic">“{rec.customer_explanation_draft}”</p>
                </div>
              </section>
            )}

            {/* Risk indicators */}
            {signals.length > 0 && (
              <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
                <h3 className="font-display text-lg font-bold">Risk indicators</h3>
                <p className="mb-3 text-xs text-graphite">Pattern signals for human review — not accusations, never auto-applied.</p>
                <ul className="space-y-3">
                  {signals.map((s, i) => (
                    <li key={i} className="rounded-xl border border-mist p-3">
                      <div className="flex items-center gap-2">
                        <Pill tone={s.severity === "high" ? "red" : s.severity === "warn" ? "gold" : "mist"}>{s.severity}</Pill>
                        <span className="text-sm font-bold">{label(s.kind)}</span>
                      </div>
                      <p className="mt-1 text-sm text-graphite">{s.summary}</p>
                      <ul className="mt-1 list-disc pl-5 text-xs text-graphite/80">{s.facts.slice(0, 6).map((f, j) => <li key={j}><code>{f}</code></li>)}</ul>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>

        {/* Audit timeline */}
        <section className="rounded-2xl border border-mist bg-white p-6 shadow-sm">
          <h3 className="font-display text-lg font-bold">Case timeline</h3>
          {events.length === 0 ? (
            <p className="mt-2 text-sm text-graphite">No events yet.</p>
          ) : (
            <ol className="mt-4 space-y-3 border-l-2 border-mist pl-5">
              {events.map((e) => (
                <li key={e.id} className="text-sm">
                  <span className="font-bold">{label(e.action)}</span>
                  <span className="text-graphite"> · {e.actor ?? "system"} · {new Date(e.created_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</span>
                  {e.detail && Object.keys(e.detail).length > 0 && (
                    <code className="mt-1 block text-[11px] text-graphite/70">{JSON.stringify(e.detail).slice(0, 300)}</code>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </AdminGate>
  );
}
